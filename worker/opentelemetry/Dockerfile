# 빌드 스테이지: 소스 코드를 빌드하고 아키텍처에 맞게 컴파일합니다.
FROM --platform=${BUILDPLATFORM} mcr.microsoft.com/dotnet/sdk:7.0 AS build
ARG TARGETPLATFORM
ARG TARGETARCH
ARG BUILDPLATFORM
RUN echo "I am running on $BUILDPLATFORM, building for $TARGETPLATFORM"

WORKDIR /source

# 프로젝트 파일을 먼저 복사하고 패키지 복원
COPY *.csproj . 
RUN dotnet restore

# 나머지 소스 파일을 복사하고 빌드
COPY . .
RUN dotnet publish -c release -o /app --runtime linux-x64 --self-contained false --no-restore

# 실행 스테이지: 빌드된 파일을 사용하여 애플리케이션을 실행합니다.
FROM mcr.microsoft.com/dotnet/runtime:7.0
WORKDIR /app
COPY --from=build /app .

# Jaeger 엔드포인트와 포트를 정의합니다.
ENV OTEL_EXPORTER_JAEGER_AGENT_HOST=13.125.194.86
ENV OTEL_EXPORTER_JAEGER_AGENT_PORT=6831

ENTRYPOINT ["dotnet", "Worker.dll"]
