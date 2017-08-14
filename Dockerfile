FROM mhart/alpine-node:6

RUN echo "http://dl-cdn.alpinelinux.org/alpine/edge/main" >> /etc/apk/repositories
RUN	echo "http://dl-cdn.alpinelinux.org/alpine/edge/testing" >> /etc/apk/repositories
ENV	HANDBRAKE_VERSION=1.0.7-r3
RUN	apk update \
	&& apk add handbrake=$HANDBRAKE_VERSION \
	&& rm -rf /var/cache/apk/*

ENV DOCKER=1
WORKDIR "/opt"
ADD ["main.js", "package.json", "package-lock.json", "/opt/"]
ADD ["lib", "/opt/lib"]

VOLUME /watch
VOLUME /encode
VOLUME /output
VOLUME /movies
VOLUME /tv
VOLUME /config

RUN ["npm", "install"]
ENTRYPOINT ["node", "main.js"]