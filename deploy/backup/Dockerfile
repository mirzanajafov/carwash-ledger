FROM postgres:18-alpine
RUN apk add --no-cache coreutils
COPY backup.sh /usr/local/bin/backup
RUN chmod +x /usr/local/bin/backup
ENTRYPOINT ["backup"]
