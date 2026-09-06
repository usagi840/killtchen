const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ----- Config -----
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
const HIDE_PHASE_MS = 30000; // killer inactive at start
const GAME_DURATION_MS = 5 * 60 * 1000; // survive time for whites
const TAG_RADIUS = 1.6;
const TICK_MS = 100;

// ----- State -----
/** rooms[roomId] = {
 *   id, hostId, status: 'lobby'|'hiding'|'playing'|'ended',
 *   players: { [socketId]: { id, name, x, z, rotY, role, alive, moving } },
 *   startedAt, killerActiveAt, endsAt, tickHandle
 * } */
const rooms = {};

function genRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id;
  do {
    id = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[id]);
  return id;
}

function publicPlayerList(room) {
  return Object.values(room.players).map((p) => ({ id: p.id, name: p.name, isHost: p.id === room.hostId }));
}

function sanitizedState(room) {
  // Roles are included: everyone can see who the killer is.
  return {
    status: room.status,
    players: Object.values(room.players).map((p) => ({
      id: p.id,
      name: p.name,
      x: p.x,
      z: p.z,
      rotY: p.rotY,
      alive: p.alive,
      role: p.role,
    })),
    hideEndsAt: room.killerActiveAt || null,
    gameEndsAt: room.endsAt || null,
  };
}

function broadcastRoom(room) {
  io.to(room.id).emit("room-update", { roomId: room.id, players: publicPlayerList(room), hostId: room.hostId });
}

function endGame(room, winner) {
  room.status = "ended";
  if (room.tickHandle) clearInterval(room.tickHandle);
  const roles = {};
  Object.values(room.players).forEach((p) => (roles[p.id] = p.role));
  io.to(room.id).emit("game-over", { winner, roles });
}

function startTick(room) {
  room.tickHandle = setInterval(() => {
    const now = Date.now();

    if (room.status === "hiding" && now >= room.killerActiveAt) {
      room.status = "playing";
    }

    if (room.status === "playing") {
      const killer = Object.values(room.players).find((p) => p.role === "killer");
      if (killer && killer.alive) {
        for (const p of Object.values(room.players)) {
          if (p.role === "white" && p.alive) {
            const dx = p.x - killer.x;
            const dz = p.z - killer.z;
            if (Math.sqrt(dx * dx + dz * dz) < TAG_RADIUS) {
              p.alive = false;
              io.to(room.id).emit("player-tagged", { id: p.id });
            }
          }
        }
      }

      const whitesLeft = Object.values(room.players).filter((p) => p.role === "white" && p.alive);
      if (whitesLeft.length === 0) {
        endGame(room, "killer");
        return;
      }
      if (now >= room.endsAt) {
        endGame(room, "white");
        return;
      }
    }

    io.to(room.id).emit("state-update", sanitizedState(room));
  }, TICK_MS);
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ name }) => {
    const roomId = genRoomId();
    const room = {
      id: roomId,
      hostId: socket.id,
      status: "lobby",
      players: {},
      startedAt: null,
      killerActiveAt: null,
      endsAt: null,
      tickHandle: null,
    };
    room.players[socket.id] = { id: socket.id, name: (name || "Joueur").slice(0, 16), x: 0, z: 0, rotY: 0, role: null, alive: true };
    rooms[roomId] = room;
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit("room-joined", { roomId, selfId: socket.id });
    broadcastRoom(room);
  });

  socket.on("join-room", ({ roomId, name }) => {
    roomId = (roomId || "").toUpperCase().trim();
    const room = rooms[roomId];
    if (!room) return socket.emit("error-msg", "Partie introuvable.");
    if (room.status !== "lobby") return socket.emit("error-msg", "La partie a déjà commencé.");
    if (Object.keys(room.players).length >= MAX_PLAYERS) return socket.emit("error-msg", "Partie complète (8 max).");

    room.players[socket.id] = { id: socket.id, name: (name || "Joueur").slice(0, 16), x: 0, z: 0, rotY: 0, role: null, alive: true };
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit("room-joined", { roomId, selfId: socket.id });
    broadcastRoom(room);
  });

  socket.on("start-game", () => {
    const room = rooms[socket.data.roomId];
    if (!room || socket.id !== room.hostId) return;
    const ids = Object.keys(room.players);
    if (ids.length < MIN_PLAYERS || ids.length > MAX_PLAYERS) {
      return socket.emit("error-msg", `Il faut entre ${MIN_PLAYERS} et ${MAX_PLAYERS} joueurs.`);
    }

    const killerId = ids[Math.floor(Math.random() * ids.length)];
    const spawnRadius = 60;
    ids.forEach((id, i) => {
      const angle = (i / ids.length) * Math.PI * 2;
      const p = room.players[id];
      p.role = id === killerId ? "killer" : "white";
      p.alive = true;
      p.x = Math.cos(angle) * spawnRadius;
      p.z = Math.sin(angle) * spawnRadius;
      p.rotY = 0;
    });

    room.status = "hiding";
    room.startedAt = Date.now();
    room.killerActiveAt = room.startedAt + HIDE_PHASE_MS;
    room.endsAt = room.killerActiveAt + GAME_DURATION_MS;

    ids.forEach((id) => {
      io.to(id).emit("game-start", {
        role: room.players[id].role,
        hideMs: HIDE_PHASE_MS,
        gameMs: GAME_DURATION_MS,
        self: { x: room.players[id].x, z: room.players[id].z },
      });
    });

    startTick(room);
    broadcastRoom(room);
  });

  socket.on("move", ({ x, z, rotY }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;
    if (room.status !== "playing" && room.status !== "hiding") return;
    // killer cannot move during hiding phase
    if (room.status === "hiding" && p.role === "killer") return;
    // tagged players (phantoms) can still move freely to spectate, they just have no gameplay effect
    p.x = x;
    p.z = z;
    p.rotY = rotY;
  });

  socket.on("disconnect", () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      if (room.tickHandle) clearInterval(room.tickHandle);
      delete rooms[room.id];
      return;
    }

    if (socket.id === room.hostId) {
      room.hostId = Object.keys(room.players)[0];
    }

    if (room.status === "playing" || room.status === "hiding") {
      const killerGone = !Object.values(room.players).some((p) => p.role === "killer");
      if (killerGone) return endGame(room, "white");
      const whitesLeft = Object.values(room.players).filter((p) => p.role === "white" && p.alive);
      if (whitesLeft.length === 0) return endGame(room, "killer");
    }

    broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Killer game server running on http://localhost:${PORT}`));
