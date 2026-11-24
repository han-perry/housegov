/**
 * Realtime hub (Socket.IO). Rooms:
 *   meeting:<id>  slide changes, ad hoc votes, minutes, agenda/decision updates
 *   poll:<id>     live result updates (only emitted when results are public)
 *
 * Clients only *listen*. Every change goes through an authenticated HTTP
 * route, which then broadcasts here, so permission checks live in one place.
 */
import type { Server as HttpServer } from "node:http";
import type { RequestHandler } from "express";
import { Server } from "socket.io";

let io: Server | null = null;

export function init(httpServer: HttpServer, sessionMiddleware: RequestHandler): Server {
  io = new Server(httpServer);
  io.engine.use(sessionMiddleware);
  io.on("connection", (socket) => {
    socket.on("join", (room: unknown) => {
      if (typeof room === "string" && /^(meeting|poll):\d+$/.test(room)) socket.join(room);
    });
    socket.on("presence", (room: unknown) => {
      if (typeof room !== "string" || !/^meeting:\d+$/.test(room)) return;
      socket.emit("presence", io!.sockets.adapter.rooms.get(room)?.size ?? 0);
    });
  });
  return io;
}

export function emit(room: string, event: string, data: unknown): void {
  io?.to(room).emit(event, data);
}
