FROM quay.io/cdis/nodejs-base

COPY . /guppy/
WORKDIR /guppy

ARG GIT_COMMIT=unknown
ARG GIT_VERSION=unknown

RUN echo "export const gitCommit = \"${GIT_COMMIT}\";" > src/server/version.js
RUN echo "export const gitVersion = \"${GIT_VERSION}\";" >> src/server/version.js
RUN /bin/rm -rf .git
RUN /bin/rm -rf node_modules

RUN chown -R gen3: /guppy
# see https://superuser.com/questions/710253/allow-non-root-process-to-bind-to-port-80-and-443
RUN  setcap CAP_NET_BIND_SERVICE=+eip "$NVM_DIR/versions/node/$NODE_VERSION/bin/node"
USER gen3
RUN source $NVM_DIR/nvm.sh && npm ci
RUN npm run-script prepare

EXPOSE 3000
EXPOSE 80

CMD [ "bash", "./startServer.sh" ]
