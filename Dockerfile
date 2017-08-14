FROM phusion/baseimage:0.9.22

# Use baseimage-docker's init system.
CMD ["/sbin/my_init"]

RUN apt-get update
RUN apt-get install -y python-software-properties

# Probably shouldn't do this but...
RUN curl -sL https://deb.nodesource.com/setup_6.x | bash -
RUN apt-get install -y nodejs handbrake-cli mediainfo

# Clean up APT when done.
RUN apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

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