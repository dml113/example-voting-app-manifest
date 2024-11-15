# Node.js 18 슬림 이미지를 베이스로 사용하여 애플리케이션의 런타임 환경을 구성합니다.
FROM node:18-slim

# 컨테이너 헬스 체크용으로 curl 및 tini를 설치합니다.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl tini && \
    rm -rf /var/lib/apt/lists/*

# 작업 디렉터리를 설정하고, 여기에 애플리케이션 소스를 복사합니다.
WORKDIR /usr/local/app

# Nodemon을 전역 설치하여 로컬 개발 중에 파일 변경을 감지하고 애플리케이션을 자동으로 재시작할 수 있게 합니다.
RUN npm install -g nodemon

# 패키지 설치를 위해 package.json과 package-lock.json을 복사합니다.
COPY package*.json ./

# npm install로 의존성을 설치하고 캐시를 정리하여 이미지 크기를 줄입니다.
RUN npm ci && \
 npm cache clean --force && \
 mv /usr/local/app/node_modules /node_modules

# 모든 애플리케이션 소스를 복사합니다.
COPY . .

# 환경 변수 PORT를 설정하고 해당 포트를 공개합니다.
ENV PORT=80
EXPOSE 80

# Tini는 프로세스 관리를 위해 사용되며, 메인 애플리케이션 프로세스를 효율적으로 관리합니다.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
