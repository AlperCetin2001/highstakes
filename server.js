const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();

/* ---------- UTIL ---------- */

function createDeck() {
  const colors = ["red", "yellow", "green", "blue"];
  const deck = [];

  for (const c of colors) {
    for (let i = 0; i <= 9; i++) {
      deck.push({ color: c, value: i });
      if (i !== 0) deck.push({ color: c, value: i });
    }
    ["skip", "reverse", "draw2"].forEach(v => {
      deck.push({ color: c, value: v });
      deck.push({ color: c, value: v });
    });
  }

  for (let i = 0; i < 4; i++) {
    deck.push({ color: "wild", value: "wild" });
    deck.push({ color: "wild", value: "draw4" });
  }

  return deck.sort(() => Math.random() - 0.5);
}

function drawCards(room, player, n) {
  for (let i = 0; i < n; i++) {
    if (!room.deck.length) room.deck = createDeck();
    player.hand.push(room.deck.pop());
  }
}

function advanceTurn(room) {
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
}

function startTurnTimer(room) {
  clearTimeout(room.timer);

  room.timer = setTimeout(() => {
    if (room.pendingChallenge) return;

    const p = room.players[room.turnIndex];
    drawCards(room, p, 1);
    room.logs.push(`⏱ ${p.name} süreyi aştı (+1).`);
    advanceTurn(room);
    broadcast(room.id);
    startTurnTimer(room);
  }, 60000);
}

function broadcast(roomId) {
  const room = rooms.get(roomId);
  io.to(roomId).emit("gameState", room);
}

/* ---------- SOCKET ---------- */

io.on("connection", socket => {
  socket.on("joinRoom", ({ roomId, name }) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        id: roomId,
        players: [],
        deck: createDeck(),
        discard: [],
        turnIndex: 0,
        timer: null,
        pendingChallenge: null,
        unoCallers: new Set(),
        logs: []
      });
    }

    const room = rooms.get(roomId);
    room.players.push({
      id: socket.id,
      name,
      hand: []
    });

    socket.join(roomId);
    broadcast(roomId);
  });

  socket.on("startGame", roomId => {
    const room = rooms.get(roomId);
    room.players.forEach(p => drawCards(room, p, 7));

    room.discard.push(room.deck.pop());
    room.turnIndex = Math.floor(Math.random() * room.players.length);
    room.logs.push("🎮 Oyun başladı.");
    startTurnTimer(room);
    broadcast(roomId);
  });

  socket.on("playCard", ({ roomId, cardIndex }) => {
    const room = rooms.get(roomId);
    const player = room.players[room.turnIndex];
    const card = player.hand.splice(cardIndex, 1)[0];

    room.discard.push(card);
    room.logs.push(`${player.name} kart attı.`);

    if (player.hand.length === 1 && !room.unoCallers.has(player.id)) {
      drawCards(room, player, 2);
      room.logs.push(`🚨 ${player.name} UNO demedi! +2`);
    }

    advanceTurn(room);
    startTurnTimer(room);
    broadcast(roomId);
  });

  socket.on("callUNO", roomId => {
    const room = rooms.get(roomId);
    room.unoCallers.add(socket.id);
    room.logs.push("🟡 UNO!");
    broadcast(roomId);
  });

  socket.on("sendChat", ({ roomId, to, message }) => {
    if (to === "ALL") {
      io.to(roomId).emit("chatMessage", {
        from: socket.id,
        message,
        private: false
      });
    } else {
      io.to(to).emit("chatMessage", {
        from: socket.id,
        message,
        private: true
      });
    }
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      room.players = room.players.filter(p => p.id !== socket.id);
      clearTimeout(room.timer);
    }
  });
});

server.listen(3000, () =>
  console.log("UNO server running on http://localhost:3000")
);
