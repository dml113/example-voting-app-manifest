var express = require('express'),
    async = require('async'),
    { Pool } = require('pg'),
    cookieParser = require('cookie-parser'),
    app = express(),
    server = require('http').Server(app),
    io = require('socket.io')(server),
    { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node'),
    { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base'),
    { registerInstrumentations } = require('@opentelemetry/instrumentation'),
    { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express'),
    { PgInstrumentation } = require('@opentelemetry/instrumentation-pg'),
    { JaegerExporter } = require('@opentelemetry/exporter-jaeger'),
    { Resource } = require('@opentelemetry/resources');  // Ensure Resource import is present
const axios = require('axios');  // 외부 HTTP 요청을 위한 axios 추가

// 서비스 이름 지정
const resource = new Resource({
  'service.name': 'voting' // Jaeger에 표시될 서비스 이름
});

// OpenTelemetry 초기화
const tracerProvider = new NodeTracerProvider({
  resource: resource
});
const exporter = new JaegerExporter({
  endpoint: 'http://jaeger-collector.istio-system.svc.cluster.local:14268/api/traces'  // Jaeger의 HTTP 수신 엔드포인트
});
tracerProvider.addSpanProcessor(new SimpleSpanProcessor(exporter));
tracerProvider.register();

// Express 및 PostgreSQL에 대한 OpenTelemetry 자동 계측 설정
registerInstrumentations({
  instrumentations: [
    new ExpressInstrumentation(),
    new PgInstrumentation()
  ],
});

const tracer = tracerProvider.getTracer('vote-tracer'); // 추적을 위한 트레이서 생성

var port = process.env.PORT || 4000;

io.on('connection', function (socket) {
  socket.emit('message', { text : 'Welcome!' });

  // OpenTelemetry 액티비티 생성: 사용자가 채널에 가입할 때
  socket.on('subscribe', function (data) {
    const span = tracer.startSpan('Socket Join Channel');
    socket.join(data.channel);
    span.end(); // 트레이스 종료
  });
});

var pool = new Pool({
  connectionString: 'postgres://postgres:postgres@db.db.svc.cluster.local/postgres'
});

// 데이터베이스 연결 시도에 대한 트레이스
async.retry(
  {times: 1000, interval: 1000},
  function(callback) {
    const span = tracer.startSpan('DB Connection Attempt'); // 트레이스 시작
    pool.connect(function(err, client, done) {
      if (err) {
        console.error("Waiting for db");
      }
      span.end(); // 트레이스 종료
      callback(err, client);
    });
  },
  function(err, client) {
    if (err) {
      return console.error("Giving up");
    }
    console.log("Connected to db");
    getVotes(client);
  }
);

function getVotes(client) {
  const span = tracer.startSpan('Get Votes'); // Votes 가져오기 작업에 대한 트레이스 시작
  client.query('SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote', [], function(err, result) {
    if (err) {
      console.error("Error performing query: " + err);
    } else {
      var votes = collectVotesFromResult(result);
      io.sockets.emit("scores", JSON.stringify(votes));
    }
    span.end(); // 트레이스 종료

    setTimeout(function() {getVotes(client) }, 1000);
  });
}

function collectVotesFromResult(result) {
  var votes = {a: 0, b: 0};

  result.rows.forEach(function (row) {
    votes[row.vote] = parseInt(row.count);
  });

  return votes;
}

app.use(cookieParser());
app.use(express.urlencoded());
app.use(express.static(__dirname + '/views'));

// 메인 페이지 로드
app.get('/', function (req, res) {
  // OpenTelemetry 액티비티 생성: 메인 페이지 로드
  const span = tracer.startSpan('Load Main Page');
  res.sendFile(path.resolve(__dirname + '/views/index.html'));
  span.end(); // 트레이스 종료
});

// 1. /healthcheck 경로 추가
app.get('/healthcheck', function (req, res) {
  res.json({status: 200});
});

// 2. /vote/healthcheck 경로 추가
app.get('/vote/healthcheck', async function (req, res) {
  try {
    const response = await axios.get('http://aac4a04ffd2cd465180a3aa3d33e2c0a-791281483.ap-northeast-2.elb.amazonaws.com:8080/healthcheck');
    res.status(response.status).send(response.data);
  } catch (error) {
    console.error('Error contacting /healthcheck endpoint:', error);
    res.status(500).json({status: 'error', message: 'Failed to reach /healthcheck endpoint'});
  }
});

server.listen(port, function () {
  var port = server.address().port;
  console.log('App running on port ' + port);
});
