FROM caddy
WORKDIR /fbi

# install bun
RUN apk update && \
    apk add curl nodejs npm

# Generate caddyfile and serve it
COPY index.mjs .
COPY Caddyfile.head .
RUN npm i yaml
CMD node index.mjs && caddy run --config /fbi/Caddyfile