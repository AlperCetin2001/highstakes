const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server, Room } = require('colyseus');
const { Schema, MapSchema, ArraySchema, type } = require('@colyseus/schema');

// --- VERİ ŞEMALARI ---
class Card extends Schema {
    constructor(c, v) { super(); this.color = c; this.value = v; }
}
type("string")(Card.prototype, "color");
type("string")(Card.prototype, "value");

class Player extends Schema {
    constructor() {
        super();
        this.hand = new ArraySchema();
        this.name = "Unknown";
        this.seat = -1;
        this.isHost = false;
        this.isDead = false;
        this.avatarColor = "#ffffff";
    }
}
type([Card])(Player.prototype, "hand");
type("string")(Player.prototype, "name");
type("number")(Player.prototype, "seat");
type("boolean")(Player.prototype, "isHost");
type("boolean")(Player.prototype, "isDead");
type("string")(Player.prototype, "avatarColor");

class GameState extends Schema {
    constructor() {
        super();
        this.players = new MapSchema();
        this.currentTurn = "";
        this.gameStatus = "LOBBY";
        this.hostId = "";
        this.topCard = new Card("black", "wild");
        this.chamber = 0; // 0-5
    }
}
type({ map: Player })(GameState.prototype, "players");
type("string")(GameState.prototype, "currentTurn");
type("string")(GameState.prototype, "gameStatus");
type("string")(GameState.prototype, "hostId");
type(Card)(GameState.prototype, "topCard");
type("number")(GameState.prototype, "chamber");

// --- ODA MANTIĞI ---
class CyberRoom extends Room {
    onCreate(options) {
        this.maxClients = 4;
        this.setState(new GameState());
        this.seats = [null, null, null, null]; // Koltuk takibi

        this.onMessage("start_game", (client) => {
            if (client.sessionId === this.state.hostId && this.state.players.size >= 2) {
                this.lock();
                this.setupGame();
            }
        });

        this.onMessage("play_card", (client, data) => this.handlePlay(client, data));
        this.onMessage("draw_card", (client) => this.handleDraw(client));
        this.onMessage("trigger", (client) => this.handleTrigger(client));
        this.onMessage("chat", (client, msg) => this.broadcast("chat_msg", { user: this.state.players.get(client.sessionId).name, text: msg }));
    }

    onJoin(client, options) {
        const p = new Player();
        p.name = (options.name || "Operative").substring(0, 12);
        p.avatarColor = `hsl(${Math.random()*360}, 100%, 50%)`;

        // Koltuk Bul
        let seatIdx = this.seats.indexOf(null);
        if (seatIdx === -1) seatIdx = 0; // Fallback
        this.seats[seatIdx] = client.sessionId;
        p.seat = seatIdx;

        // Host Ata
        if (this.state.players.size === 0) {
            p.isHost = true;
            this.state.hostId = client.sessionId;
        }

        this.state.players.set(client.sessionId, p);
        this.broadcast("notification", `> ${p.name.toUpperCase()} SİSTEME GİRİŞ YAPTI.`);
    }

    onLeave(client) {
        const p = this.state.players.get(client.sessionId);
        if (p) this.seats[p.seat] = null;
        this.state.players.delete(client.sessionId);

        // Yeni Host
        if (client.sessionId === this.state.hostId && this.state.players.size > 0) {
            const nextId = this.state.players.keys().next().value;
            this.state.hostId = nextId;
            this.state.players.get(nextId).isHost = true;
            this.broadcast("notification", "> YENİ YÖNETİCİ ATANDI.");
        }
    }

    setupGame() {
        // Deste
        const colors = ["red", "blue", "green", "yellow"];
        const vals = ["0","1","2","3","4","5","6","7","8","9","skip","reverse","+2"];
        const deck = [];
        colors.forEach(c => {
            vals.forEach(v => deck.push(new Card(c, v)));
            deck.push(new Card("black", "wild"));
        });
        deck.sort(() => Math.random() - 0.5);

        // Dağıt
        this.state.players.forEach(p => {
            p.hand.clear();
            for(let i=0; i<7; i++) p.hand.push(deck.pop());
        });

        // Ortaya koy
        let top = deck.pop();
        while(top.color === "black") top = deck.pop();
        this.state.topCard = new Card(top.color, top.value);

        // Sıra
        this.state.playerKeys = Array.from(this.state.players.keys());
        this.state.turnIdx = 0;
        this.state.currentTurn = this.state.playerKeys[0];
        
        // Rulet
        this.state.chamber = Math.floor(Math.random() * 6);
        this.state.gameStatus = "PLAYING";
        
        this.broadcast("start_game");
    }

    handlePlay(client, data) {
        if (this.state.currentTurn !== client.sessionId) return;
        const p = this.state.players.get(client.sessionId);
        const card = p.hand[data.index];
        const top = this.state.topCard;

        if (card.color === "black" || card.color === top.color || card.value === top.value) {
            p.hand.splice(data.index, 1);
            if (data.color) card.color = data.color;
            this.state.topCard = new Card(card.color, card.value);

            if (p.hand.length === 0) {
                this.broadcast("notification", `>>> ${p.name} KAZANDI! <<<`);
                this.broadcast("game_over", p.name);
            } else {
                if (card.value === "skip" || card.value === "reverse") this.rotateTurn(); // 2 kişilikte reverse=skip
                this.rotateTurn();
            }
        }
    }

    handleDraw(client) {
        if (this.state.currentTurn !== client.sessionId) return;
        const p = this.state.players.get(client.sessionId);
        // Random kart
        const colors = ["red", "blue", "green", "yellow"];
        p.hand.push(new Card(colors[Math.floor(Math.random()*4)], Math.floor(Math.random()*9).toString()));
        this.rotateTurn();
    }

    handleTrigger(client) {
        // Basit Rulet: %16 Şans
        const dead = Math.random() < 0.166;
        if(dead) {
            const p = this.state.players.get(client.sessionId);
            p.isDead = true;
            this.broadcast("notification", `!!! ${p.name} ELENDİ !!!`);
            this.broadcast("sound", "bang");
        } else {
            this.broadcast("notification", `> ${this.state.players.get(client.sessionId).name} HAYATTA KALDI.`);
            this.broadcast("sound", "click");
        }
        this.rotateTurn();
    }

    rotateTurn() {
        let loop = 0;
        do {
            this.state.turnIdx = (this.state.turnIdx + 1) % this.state.playerKeys.length;
            const nextId = this.state.playerKeys[this.state.turnIdx];
            const p = this.state.players.get(nextId);
            if (p && !p.isDead) {
                this.state.currentTurn = nextId;
                return;
            }
            loop++;
        } while(loop < 5);
    }
}

const app = express();
app.use(cors());
app.use(express.json());
app.get('/healthz', (req, res) => res.send('OK'));

const server = http.createServer(app);
const gameServer = new Server({ server: server });
gameServer.define("high_stakes_room", CyberRoom).enableRealtimeListing();

server.listen(process.env.PORT || 3000, () => console.log("Cyber Core Online"));
