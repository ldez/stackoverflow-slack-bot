FROM node:8-alpine
LABEL maintainer="lfernandez.dev@gmail.com"
WORKDIR /usr/src/bot
COPY . .
RUN npm install
CMD [ "npm", "start" ]
