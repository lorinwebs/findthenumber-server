import express from "express";
import { createServer } from "http";
import { Server, Socket } from "socket.io";

const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: "*" } });

const PORT = parseInt(process.env.PORT || "3001", 10);
const TOTAL_NUMBERS = 50;
const WIN_TARGET = 10;
const DYNAMIC_WAIT_MS = 10000;

interface Player {
  socket: Socket;
  foundCount: number;
}

interface GameRoom {
  id: string;
  seed: number;
  targets: number[];
  players: Player[];
  finished: boolean;
}

const dynamicQueue: Socket[] = [];
let dynamicTimer: ReturnType<typeof setTimeout> | null = null;
let dynamicTimerEnd: number | null = null;

const exactQueues = new Map<number, Socket[]>([
  [2, []],
  [3, []],
  [4, []],
]);

const rooms = new Map<string, GameRoom>();
const socketToRoom = new Map<string, string>();
const socketToQueue = new Map<string, string>();

function shuffleWithSeed(arr: number[], seed: number): number[] {
  const result = [...arr];
  let s = seed;
  for (let i = result.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = (s >>> 0) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function createRoom(players: Socket[]): GameRoom {
  const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const seed = Math.floor(Math.random() * 2147483647);
  const nums = Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1);
  const targets = shuffleWithSeed(nums, seed);

  const room: GameRoom = {
    id: roomId,
    seed,
    targets,
    players: players.map((s) => ({ socket: s, foundCount: 0 })),
    finished: false,
  };

  rooms.set(roomId, room);
  players.forEach((s) => {
    socketToRoom.set(s.id, roomId);
    s.join(roomId);
  });

  players.forEach((s, idx) => {
    s.emit("game_start", {
      roomId,
      seed,
      targets,
      playerIndex: idx,
      playerCount: players.length,
    });
  });

  console.log(`Room ${roomId} created | ${players.length} players | seed=${seed}`);
  return room;
}

function tryStartDynamic() {
  if (dynamicQueue.length >= 2) {
    const players = dynamicQueue.splice(0);
    players.forEach((s) => socketToQueue.delete(s.id));
    createRoom(players);
  } else {
    dynamicQueue.forEach((s) => {
      s.emit("queue_expired");
      socketToQueue.delete(s.id);
    });
    dynamicQueue.length = 0;
  }
  if (dynamicTimer) clearTimeout(dynamicTimer);
  dynamicTimer = null;
  dynamicTimerEnd = null;
}

function emitDynamicQueueUpdate() {
  const countdown = dynamicTimerEnd
    ? Math.max(0, Math.ceil((dynamicTimerEnd - Date.now()) / 1000))
    : 10;
  dynamicQueue.forEach((s) =>
    s.emit("queue_update", { count: dynamicQueue.length, countdown })
  );
}

function removeFromAllQueues(socket: Socket) {
  const qType = socketToQueue.get(socket.id);
  if (!qType) return;

  if (qType === "dynamic") {
    const idx = dynamicQueue.indexOf(socket);
    if (idx !== -1) dynamicQueue.splice(idx, 1);
    emitDynamicQueueUpdate();
    if (dynamicQueue.length === 0 && dynamicTimer) {
      clearTimeout(dynamicTimer);
      dynamicTimer = null;
      dynamicTimerEnd = null;
    }
  } else if (qType.startsWith("exact_")) {
    const count = parseInt(qType.split("_")[1]);
    const q = exactQueues.get(count);
    if (q) {
      const idx = q.indexOf(socket);
      if (idx !== -1) q.splice(idx, 1);
      q.forEach((s) =>
        s.emit("queue_update", { count: q.length, target: count })
      );
    }
  }
  socketToQueue.delete(socket.id);
}

io.on("connection", (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on(
    "join_queue",
    (data?: { mode?: string; playerCount?: number }) => {
      const mode = data?.mode || "dynamic";
      const playerCount = data?.playerCount || 2;

      removeFromAllQueues(socket);

      if (mode === "dynamic") {
        dynamicQueue.push(socket);
        socketToQueue.set(socket.id, "dynamic");
        console.log(`Dynamic queue: ${dynamicQueue.length}`);

        if (dynamicQueue.length === 1) {
          dynamicTimerEnd = Date.now() + DYNAMIC_WAIT_MS;
          dynamicTimer = setTimeout(() => tryStartDynamic(), DYNAMIC_WAIT_MS);
        }

        emitDynamicQueueUpdate();

        if (dynamicQueue.length >= 4) {
          tryStartDynamic();
        }
      } else {
        const q = exactQueues.get(playerCount);
        if (!q) return;
        q.push(socket);
        socketToQueue.set(socket.id, `exact_${playerCount}`);
        console.log(`Exact ${playerCount} queue: ${q.length}`);
        q.forEach((s) =>
          s.emit("queue_update", { count: q.length, target: playerCount })
        );

        if (q.length >= playerCount) {
          const players = q.splice(0, playerCount);
          players.forEach((s) => socketToQueue.delete(s.id));
          createRoom(players);
        }
      }
    }
  );

  socket.on("cancel_queue", () => {
    removeFromAllQueues(socket);
  });

  socket.on("found", (data: { number: number }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.finished) return;

    const playerIdx = room.players.findIndex(
      (p) => p.socket.id === socket.id
    );
    if (playerIdx === -1) return;

    const player = room.players[playerIdx];
    const expectedTarget = room.targets[player.foundCount];
    if (data.number !== expectedTarget) return;

    player.foundCount++;
    const scores = room.players.map((p) => p.foundCount);
    const gameOver = player.foundCount >= WIN_TARGET;

    if (gameOver) room.finished = true;

    room.players.forEach((p, idx) => {
      p.socket.emit("score_update", {
        scores,
        foundBy: playerIdx,
        number: data.number,
        gameOver,
        isWinner: gameOver ? idx === playerIdx : undefined,
      });
    });

    if (gameOver) {
      console.log(`Room ${roomId} finished | winner=player${playerIdx}`);
    }
  });

  socket.on("disconnect", () => {
    console.log(`Disconnected: ${socket.id}`);
    removeFromAllQueues(socket);

    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room && !room.finished) {
        room.players = room.players.filter(
          (p) => p.socket.id !== socket.id
        );
        if (room.players.length <= 1) {
          room.finished = true;
          room.players.forEach((p) => p.socket.emit("player_left"));
        } else {
          const scores = room.players.map((p) => p.foundCount);
          room.players.forEach((p, idx) => {
            p.socket.emit("player_disconnected", {
              playerCount: room.players.length,
              scores,
              playerIndex: idx,
            });
          });
        }
      }
      socketToRoom.delete(socket.id);
    }
  });
});

app.get("/", (_req, res) => res.send("Game server running"));

app.get("/privacy", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy – מצא את המספר</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; background: #0C0C1E; color: #e0e0e0; line-height: 1.7; }
    h1 { color: #FFD700; font-size: 24px; }
    h2 { color: #66CCFF; font-size: 18px; margin-top: 28px; }
    a { color: #66CCFF; }
    .updated { color: rgba(255,255,255,0.4); font-size: 13px; }
  </style>
</head>
<body>
  <h1>מדיניות פרטיות – מצא את המספר</h1>
  <p class="updated">עדכון אחרון: מרץ 2026</p>

  <h2>מידע שנאסף</h2>
  <p>האפליקציה <strong>לא אוספת, לא שומרת ולא משתפת</strong> מידע אישי. כינוי (nickname) נשמר מקומית על המכשיר שלך בלבד ולא נשלח לשרת.</p>

  <h2>משחק אונליין</h2>
  <p>במצב מרובה משתתפים, המכשיר מתחבר לשרת משחק באמצעות WebSocket. לא נשמר שום מידע מזהה לאחר סיום המשחק.</p>

  <h2>שירותי צד שלישי</h2>
  <p>האפליקציה לא משתמשת בשירותי אנליטיקס, פרסום או מעקב.</p>

  <h2>יצירת קשר</h2>
  <p>לשאלות בנוגע למדיניות זו: <a href="mailto:lorin.totah0@gmail.com">lorin.totah0@gmail.com</a></p>
</body>
</html>`);
});

http.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
