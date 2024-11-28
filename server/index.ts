import fs from "fs";
import cors from "cors";
import http from "http";
import express from "express";
import { Server } from "socket.io";
import logger from "./middleware/logger";

export const app = express();

const server = http.createServer(app);

const port = process.env.PORT || 3001;

//Logger middleware
app.use(logger);

//Middleware
app.use(cors());
app.disable("x-powered-by");

const io = new Server(server, {
  cors: {
    origin: process.env.ELECTRON_HOST,
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log(`Socket is connected`);

  socket.on("video-chunks", async (data) => {
    console.log("Video chunk is sent", data);

    const writeStream = fs.createWriteStream(data);
  });

  socket.on("process-video", async (data) => {
    console.log("Processing video...", data);
  });

  socket.on("disconnect", async () => {
    console.log("Socket disconnected", socket.id);
  });
});

server.listen(port, () => {
  console.log(`App running on port:${port}`);
});
