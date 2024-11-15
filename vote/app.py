from flask import Flask, render_template, request, make_response, g, jsonify
from redis import Redis
import os
import socket
import random
import json
import logging
import requests  # requests module added

# OpenTelemetry modules
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

# 1. Initialize OpenTelemetry tracer
resource = Resource(attributes={"service.name": "vote-app"})  # Service name for Jaeger
trace.set_tracer_provider(TracerProvider(resource=resource))
tracer = trace.get_tracer(__name__)

# 2. Set up Jaeger exporter and BatchSpanProcessor
jaeger_exporter = JaegerExporter(
    agent_host_name="15.164.227.173",  # Jaeger host
    agent_port=6831  # Default Jaeger port for spans
)
span_processor = BatchSpanProcessor(jaeger_exporter)
trace.get_tracer_provider().add_span_processor(span_processor)

# 3. Instrument Flask, Redis, and requests
FlaskInstrumentor().instrument_app(app)
RedisInstrumentor().instrument()
RequestsInstrumentor().instrument()

def get_redis():
    if not hasattr(g, 'redis'):
        g.redis = Redis(host="redis", db=0, socket_timeout=5)
    return g.redis

@app.route("/", methods=['POST', 'GET'])
def hello():
    # Root Span creation
    with tracer.start_as_current_span("http-request") as root_span:
        root_span.set_attribute("http.method", request.method)
        root_span.set_attribute("http.url", request.url)

        voter_id = request.cookies.get('voter_id')
        if not voter_id:
            voter_id = hex(random.getrandbits(64))[2:-1]

        vote = None

        if request.method == 'POST':
            with tracer.start_as_current_span("process-vote"):
                redis = get_redis()
                vote = request.form['vote']
                app.logger.info('Received vote for %s', vote)
                data = json.dumps({'voter_id': voter_id, 'vote': vote})
                redis.rpush('votes', data)

        with tracer.start_as_current_span("render-template"):
            resp = make_response(render_template(
                'index.html',
                option_a=option_a,
                option_b=option_b,
                hostname=hostname,
                vote=vote,
            ))
            resp.set_cookie('voter_id', voter_id)

        root_span.set_attribute("response.status_code", 200)
        return resp

# 4. Add /healthcheck route
@app.route("/healthcheck", methods=['GET'])
def healthcheck():
    with tracer.start_as_current_span("healthcheck") as span:
        span.set_attribute("http.method", request.method)
        span.set_attribute("http.url", request.url)
        span.set_attribute("response.status_code", 200)
        return jsonify({"status": 200})

if __name__ == "__main__":
    app.run(host='0.0.0.0', port=80, debug=True, threaded=True)
