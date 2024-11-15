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
    { Resource } = require('@opentelemetry/resources'),
    path = require('path');

// 서비스 이름 지정
const resource = new Resource({
  'service.name': 'result-app' // Jaeger에 표시될 서비스 이름
});

// OpenTelemetry 초기화
const tracerProvider = new NodeTracerProvider({
  resource: resource
});
const exporter = new JaegerExporter({
  endpoint: 'http://15.164.227.173:14268/api/traces'  // Jaeger의 HTTP 수신 엔드포인트
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
  socket.emit('message', { text: 'Welcome!' });

  // OpenTelemetry 액티비티 생성: 사용자가 채널에 가입할 때
  socket.on('subscribe', function (data) {
    const span = tracer.startSpan('Socket Join Channel');
    socket.join(data.channel);
    span.end(); // 트레이스 종료
  });
});

var pool = new Pool({
  connectionString: 'postgres://postgres:postgres@db/postgres'
});

// 요청 단위 Root Span 생성 미들웨어
app.use((req, res, next) => {
  const rootSpan = tracer.startSpan(`HTTP ${req.method} ${req.url}`);
  req.rootSpan = rootSpan;

  // 응답 종료 시 Root Span 종료
  res.on('finish', () => {
    rootSpan.end();
  });

  next();
});

// 메인 페이지 로드
app.get('/', function (req, res) {
  const span = tracer.startSpan('Load Main Page', { parent: req.rootSpan });
  res.sendFile(path.resolve(__dirname + '/views/index.html'));
  span.end();
});

// /healthcheck 경로
app.get('/healthcheck', function (req, res) {
  const span = tracer.startSpan('Health Check', { parent: req.rootSpan });
  res.json({ status: 200 });
  span.end();
});

// 데이터베이스 연결 및 투표 가져오기 트레이싱
async.retry(
  { times: 1000, interval: 1000 },
  function (callback) {
    const span = tracer.startSpan('DB Connection Attempt');
    pool.connect(function (err, client) {
      span.end();
      callback(err, client);
    });
  },
  function (err, client) {
    if (err) {
      return console.error("Giving up");
    }
    console.log("Connected to db");
    getVotes(client, null); // 부모 Span 없음
  }
);

function getVotes(client, parentSpan) {
  const span = tracer.startSpan('Get Votes', { parent: parentSpan });

  client.query('SELECT vote, COUNT(id) AS count FROM votes GROUP BY vote', [], function (err, result) {
    if (err) {
      console.error("Error performing query: " + err);
    } else {
      var votes = collectVotesFromResult(result);
      io.sockets.emit("scores", JSON.stringify(votes));
    }
    span.end();

    setTimeout(function () {
      getVotes(client, parentSpan);
    }, 1000);
  });
}

function collectVotesFromResult(result) {
  var votes = { a: 0, b: 0 };

  result.rows.forEach(function (row) {
    votes[row.vote] = parseInt(row.count);
  });

  return votes;
}

app.use(cookieParser());
app.use(express.urlencoded());
app.use(express.static(__dirname + '/views'));

server.listen(port, function () {
  console.log('App running on port ' + port);
});
