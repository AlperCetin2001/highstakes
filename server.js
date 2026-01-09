const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server, Room } = require('colyseus');
const { Schema, MapSchema, ArraySchema, type } = require('@colyseus/schema');

// --- VERİ MODELİ (SCHEMA) ---
class Card extends Schema {
    constructor(color, value) {
        super();
        this.color = color;
        this.value = value;
    }
}
type("string")(Card.prototype, "color");
type("string")(Card.prototype, "value");

class Player extends Schema {
    constructor() {
        super();
        this.hand = new ArraySchema();
        this.name = "Unknown";
        this.isHost = false;
        this.seatIndex = -1; // 0-3
        this.ready = false;
        this.avatarColor = "#ffffff";
    }
}
type([Card])(Player.prototype, "hand");
type("string")(Player.prototype, "name");
type("boolean")(Player.prototype, "isHost");
type("number")(Player.prototype, "seatIndex");
type("string")(Player.prototype, "avatarColor");

class GameState extends Schema {
    constructor() {
        super();
        this.players = new MapSchema();
        this.currentTurn = "";
        this.direction = 1; 
        this.gameStatus = "LOBBY"; 
        this.topCard = new Card("black", "wild");
        this.drawStack = 0;
        this.hostId = "";
    }
}
type({ map: Player })(GameState.prototype, "players");
type("string")(GameState.prototype, "currentTurn");
type("string")(GameState.prototype, "gameStatus");
type("string")(GameState.prototype, "hostId");
type(Card)(GameState.prototype, "topCard");

// --- ODA MANTIĞI ---
class UnoRoom extends Room {
    onCreate(options) {
        this.maxClients = 4;
        this.setState(new GameState());
        this.seats = [null, null, null, null]; 

        this.onMessage("start_game", (client) => {
            if (client.sessionId === this.state.hostId && this.state.players.size >= 2) {
                this.lock(); 
                this.setupGame();
            }
        });

        this.onMessage("play_card", (client, data) => this.handlePlay(client, data));
        this.onMessage("draw_card", (client) => this.handleDraw(client));
        this.onMessage("chat", (client, msg) => {
            const p = this.state.players.get(client.sessionId);
            this.broadcast("chat_msg", { user: p.name, text: msg });
        });
        
        // Tetik (Rulet) Mantığı
        this.onMessage("trigger", (client) => {
             // %16 Ölme Şansı
             const dead = Math.random() < 0.166;
             if(dead) {
                 this.broadcast("notification", `${this.state.players.get(client.sessionId).name} ELENDİ!`);
                 this.broadcast("game_over", "KASA"); // Basit bitiş
             } else {
                 this.broadcast("notification", "BOŞ TETİK. OYUN DEVAM EDİYOR.");
                 this.nextTurn(1);
             }
        });
    }

    onJoin(client, options) {
        const p = new Player();
        p.name = (options.name || "Player").substring(0, 12);
        p.avatarColor = `hsl(${Math.random()*360}, 100%, 50%)`;
        
        let seat = this.seats.indexOf(null);
        if (seat === -1) seat = 0; 
        this.seats[seat] = client.sessionId;
        p.seatIndex = seat;

        if (this.state.players.size === 0) {
            p.isHost = true;
            this.state.hostId = client.sessionId;
        }

        this.state.players.set(client.sessionId, p);
        this.broadcast("notification", `${p.name} KATILDI.`);
    }

    onLeave(client) {
        const p = this.state.players.get(client.sessionId);
        if(p) this.seats[p.seatIndex] = null;
        this.state.players.delete(client.sessionId);
        
        if (client.sessionId === this.state.hostId && this.state.players.size > 0) {
            const nextId = this.state.players.keys().next().value;
            this.state.hostId = nextId;
            this.state.players.get(nextId).isHost = true;
            this.broadcast("notification", "YENİ HOST ATANDI.");
        }
    }

    setupGame() {
        const colors = ["red", "blue", "green", "yellow"];
        const values = ["0","1","2","3","4","5","6","7","8","9","skip","reverse","+2"];
        const deck = [];
        colors.forEach(c => {
            values.forEach(v => { deck.push(new Card(c, v)); if(v!=="0") deck.push(new Card(c,v)); });
            deck.push(new Card("black", "wild"));
            deck.push(new Card("black", "+4"));
        });

        this.deck = deck.sort(() => Math.random() - 0.5);

        this.state.players.forEach(p => {
            p.hand.clear();
            for(let i=0; i<7; i++) p.hand.push(this.drawFromDeck());
        });

        let top = this.drawFromDeck();
        while(top.color === "black") top = this.drawFromDeck();
        this.state.topCard = top;

        this.playerKeys = Array.from(this.state.players.keys());
        this.turnIndex = 0;
        this.state.currentTurn = this.playerKeys[0];
        this.state.gameStatus = "PLAYING";
        
        this.broadcast("start_game");
    }

    handlePlay(client, data) {
        if(this.state.currentTurn !== client.sessionId) return;
        const p = this.state.players.get(client.sessionId);
        const card = p.hand[data.index];
        const top = this.state.topCard;

        let isValid = (card.color === "black") || (card.color === top.color || card.value === top.value);

        if (isValid) {
            p.hand.splice(data.index, 1);
            if (data.color) card.color = data.color;
            this.state.topCard = new Card(card.color, card.value);

            if (p.hand.length === 0) {
                this.broadcast("game_over", p.name);
                this.state.gameStatus = "LOBBY";
            } else {
                if (card.value === "skip") this.nextTurn(2);
                else if (card.value === "reverse") {
                    if (this.state.players.size === 2) this.nextTurn(2);
                    else { this.state.direction *= -1; this.nextTurn(1); }
                }
                else if (card.value === "+2") { this.state.drawStack += 2; this.nextTurn(1); }
                else if (card.value === "+4") { this.state.drawStack += 4; this.nextTurn(1); }
                else { this.nextTurn(1); }
            }
        }
    }

    handleDraw(client) {
        if(this.state.currentTurn !== client.sessionId) return;
        const p = this.state.players.get(client.sessionId);
        const count = this.state.drawStack > 0 ? this.state.drawStack : 1;
        for(let i=0; i<count; i++) p.hand.push(this.drawFromDeck());
        this.state.drawStack = 0;
        this.nextTurn(1);
    }

    nextTurn(step) {
        const len = this.playerKeys.length;
        if (this.state.direction === 1) this.turnIndex = (this.turnIndex + step) % len;
        else this.turnIndex = (this.turnIndex - step + len * 10) % len;
        this.state.currentTurn = this.playerKeys[this.turnIndex];
    }

    drawFromDeck() {
        if (this.deck.length === 0) {
            const colors = ["red", "blue", "green", "yellow"];
            const vals = ["1","2","3","4","5","6","7","8","9"];
            return new Card(colors[Math.floor(Math.random()*4)], vals[Math.floor(Math.random()*9)]);
        }
        return this.deck.pop();
    }
}

const app = express();
app.use(cors());
app.use(express.json());
app.get('/healthz', (req, res) => res.send('OK'));

const server = http.createServer(app);
const gameServer = new Server({ server: server });

// KRİTİK NOKTA: Buradaki isim "uno_room" olmalı!
gameServer.define("uno_room", UnoRoom).enableRealtimeListing();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("UNO Server Online"));
