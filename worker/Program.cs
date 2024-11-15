using System.Diagnostics;
using System;
using System.Data.Common;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using Newtonsoft.Json;
using Npgsql;
using StackExchange.Redis;
using OpenTelemetry;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Worker
{
    public class Program
    {
        // OpenTelemetry TracerProvider 정의
        private static readonly TracerProvider tracerProvider = Sdk.CreateTracerProviderBuilder()
            .SetResourceBuilder(ResourceBuilder.CreateDefault().AddService("backend")) // Jaeger에 표시될 서비스 이름
            .AddSource("backend") // 트레이스 소스 이름
            .AddJaegerExporter(o =>
            {
                o.AgentHost = "15.164.227.173"; // Jaeger 호스트 주소
                o.AgentPort = 6831;             // Jaeger 기본 포트
            })
            .Build();

        private static readonly ActivitySource activitySource = new("backend"); // 트레이스 소스 정의

        public static int Main(string[] args)
        {
            try
            {
                var pgsql = OpenDbConnection("Server=db;Username=postgres;Password=postgres;");
                var redisConn = OpenRedisConnection("redis");
                var redis = redisConn.GetDatabase();

                var keepAliveCommand = pgsql.CreateCommand();
                keepAliveCommand.CommandText = "SELECT 1";

                var definition = new { vote = "", voter_id = "" };

                while (true)
                {
                    Thread.Sleep(100);

                    // 루프의 각 실행을 독립적인 트레이스로 만듦
                    using var iterationActivity = activitySource.StartActivity("Worker_Loop", ActivityKind.Server);

                    // Redis 연결 확인 및 재연결
                    if (redisConn == null || !redisConn.IsConnected)
                    {
                        using var redisReconnectActivity = activitySource.StartActivity("Redis_Reconnect", ActivityKind.Client);
                        Console.WriteLine("Reconnecting Redis");
                        redisConn = OpenRedisConnection("redis");
                        redis = redisConn.GetDatabase();
                    }

                    // Redis에서 메시지 가져오기
                    string json = redis.ListLeftPopAsync("votes").Result;
                    if (json != null)
                    {
                        var vote = JsonConvert.DeserializeAnonymousType(json, definition);
                        Console.WriteLine($"Processing vote for '{vote.vote}' by '{vote.voter_id}'");

                        // DB 작업 추적
                        using var dbActivity = activitySource.StartActivity("DB_Operation", ActivityKind.Client);
                        if (!pgsql.State.Equals(System.Data.ConnectionState.Open))
                        {
                            Console.WriteLine("Reconnecting DB");
                            pgsql = OpenDbConnection("Server=db;Username=postgres;Password=postgres;");
                        }
                        else
                        {
                            UpdateVote(pgsql, vote.voter_id, vote.vote);
                        }
                    }
                    else
                    {
                        // Keep-Alive 명령 실행 (스팬 생성을 생략)
                        keepAliveCommand.ExecuteNonQuery();
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.ToString());
                return 1;
            }
        }

        private static NpgsqlConnection OpenDbConnection(string connectionString)
        {
            NpgsqlConnection connection;
            while (true)
            {
                try
                {
                    connection = new NpgsqlConnection(connectionString);
                    connection.Open();
                    break;
                }
                catch (SocketException)
                {
                    Console.Error.WriteLine("Waiting for db");
                    Thread.Sleep(1000);
                }
                catch (DbException)
                {
                    Console.Error.WriteLine("Waiting for db");
                    Thread.Sleep(1000);
                }
            }

            Console.Error.WriteLine("Connected to db");

            var command = connection.CreateCommand();
            command.CommandText = @"CREATE TABLE IF NOT EXISTS votes (
                                        id VARCHAR(255) NOT NULL UNIQUE,
                                        vote VARCHAR(255) NOT NULL
                                    )";
            command.ExecuteNonQuery();

            return connection;
        }

        private static ConnectionMultiplexer OpenRedisConnection(string hostname)
        {
            var ipAddress = GetIp(hostname);
            Console.WriteLine($"Found redis at {ipAddress}");

            while (true)
            {
                try
                {
                    Console.Error.WriteLine("Connecting to redis");
                    return ConnectionMultiplexer.Connect(ipAddress);
                }
                catch (RedisConnectionException)
                {
                    Console.Error.WriteLine("Waiting for redis");
                    Thread.Sleep(1000);
                }
            }
        }

        private static string GetIp(string hostname)
            => Dns.GetHostEntryAsync(hostname)
                .Result
                .AddressList
                .First(a => a.AddressFamily == AddressFamily.InterNetwork)
                .ToString();

        private static void UpdateVote(NpgsqlConnection connection, string voterId, string vote)
        {
            using var updateVoteActivity = activitySource.StartActivity("UpdateVote", ActivityKind.Client);

            var command = connection.CreateCommand();
            try
            {
                command.CommandText = "INSERT INTO votes (id, vote) VALUES (@id, @vote)";
                command.Parameters.AddWithValue("@id", voterId);
                command.Parameters.AddWithValue("@vote", vote);
                command.ExecuteNonQuery();
            }
            catch (DbException)
            {
                command.CommandText = "UPDATE votes SET vote = @vote WHERE id = @id";
                command.ExecuteNonQuery();
            }
            finally
            {
                command.Dispose();
            }
        }
    }
}
