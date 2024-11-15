from flask import Flask, render_template, request, make_response, g, jsonify
from redis import Redis
import os
import socket
import random
import json
import logging
import requests  # requests 모듈 추가

# OpenTelemetry 관련 모듈 불러오기
from opentelemetry import trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.jaeger.thrift import JaegerExporter
from opentelemetry.instrumentation.flask import FlaskInstrumentor
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.instrumentation.requests import RequestsInstrumentor

option_a = os.getenv('OPTION_A', "Cats")
option_b = os.getenv('OPTION_B', "Dogs")
hostname = socket.gethostname()

app = Flask(__name__)

gunicorn_error_logger = logging.getLogger('gunicorn.error')
app.logger.handlers.extend(gunicorn_error_logger.handlers)
app.logger.setLevel(logging.INFO)

# 1. OpenTelemetry 트레이서를 초기화
resource = Resource(attributes={"service.name": "vote-test"})  # Jaeger에 표시될 서비스 이름 정의
trace.set_tracer_provider(TracerProvider(resource=resource))
tracer = trace.get_tracer(__name__)

# 2. Jaeger 익스포터와 BatchSpanProcessor 설정
jaeger_exporter = JaegerExporter(
    agent_host_name="jaeger-collector.istio-system.svc.cluster.local",  # Jaeger의 호스트 주소
    agent_port=14268  # Jaeger가 스팬을 수신하는 기본 포트
)
span_processor = BatchSpanProcessor(jaeger_exporter)
trace.get_tracer_provider().add_span_processor(span_processor)

# 3. Flask와 Redis 자동 계측기 설정
FlaskInstrumentor().instrument_app(app)  # Flask 애플리케이션에 자동 계측 추가
RedisInstrumentor().instrument()  # Redis 클라이언트에 자동 계측 추가
RequestsInstrumentor().instrument()  # requests 모듈에 자동 계측 추가 (한 번만 설정)

def get_redis():
    if not hasattr(g, 'redis'):
        g.redis = Redis(host="redis.redis.svc.cluster.local", db=0, socket_timeout=5)
    return g.redis

@app.route("/", methods=['POST','GET'])
def hello():
    with tracer.start_as_current_span("server-process"):
        voter_id = request.cookies.get('voter_id')
        if not voter_id:
            voter_id = hex(random.getrandbits(64))[2:-1]

        vote = None

        if request.method == 'POST':
            redis = get_redis()
            vote = request.form['vote']
            app.logger.info('Received vote for %s', vote)
            data = json.dumps({'voter_id': voter_id, 'vote': vote})
            redis.rpush('votes', data)

        resp = make_response(render_template(
            'index.html',
            option_a=option_a,
            option_b=option_b,
            hostname=hostname,
            vote=vote,
        ))
        resp.set_cookie('voter_id', voter_id)
        return resp

# 4. /healthcheck 경로 추가
@app.route("/healthcheck", methods=['GET'])
def healthcheck():
    return jsonify({"status": 200})

if __name__ == "__main__":
    app.run(host='0.0.0.0', port=80, debug=True, threaded=True)
