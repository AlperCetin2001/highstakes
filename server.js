const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server, Room } = require('colyseus');
const { Schema, MapSchema, ArraySchema, type } = require('@colyseus/schema');

// --- VERİ YAPILARI ---
class Card extends Schema {
    constructor(c, v) { super(); this.color = c; this.value = v; }
}
type("string")(Card.prototype, "color");
type("string")(Card.prototype, "value");

class Player extends Schema {
    constructor() {
        super();
        this.hand = new ArraySchema();
        this.name = "Player";
        this.seatIndex = -1; // 0, 1, 2, 3
        this.isHost = false;
        this.isDead = false;
    }
}
type([Card])(Player.prototype, "hand");
type("string")(Player.prototype, "name");
type("number")(Player.prototype, "seatIndex");
type("boolean")(Player.prototype, "isHost");
type("boolean")(Player.prototype, "isDead");

class GameState extends Schema {
    constructor() {
        super();
        this.players = new MapSchema();
        this.currentTurn = "";
        this.gameStatus = "LOBBY"; 
        this.hostId = "";
    }
}
type({ map: Player })(GameState.prototype, "players");
type("string")(GameState.prototype, "currentTurn");
type("string")(GameState.prototype, "gameStatus");
type("string")(GameState.prototype, "hostId");
type(Card)(GameState.prototype, "topCard");

// --- ODA MANTIĞI ---
class HighStakesRoom extends Room {
    onCreate(options) {
        this.maxClients = 4;
        this.setState(new GameState());
        this.seats = [false, false, false, false]; // Koltuk doluluk durumu

        this.onMessage("start_game", (client) => {
            if (client.sessionId === this.state.hostId && this.state.players.size >= 2) {
                this.lock(); // Odayı kilitle
                this.setupGame();
            }
        });

        this.onMessage("play_card", (client, data) => this.handlePlay(client, data));
        this.onMessage("draw_card", (client) => this.handleDraw(client));
        this.onMessage("trigger_result", (client, res) => this.handleRoulette(client, res));
        
        // Chat
        this.onMessage("chat_msg", (client, msg) => {
            const p = this.state.players.get(client.sessionId);
            this.broadcast("chat_broadcast", { name: p.name, msg: msg });
        });
    }

    onJoin(client, options) {
        const player = new Player();
        player.name = options.name || `Ajan ${Math.floor(Math.random()*999)}`;
        
        // Boş koltuk bul
        let seat = this.seats.findIndex(s => s === false);
        if(seat === -1) seat = 0; // Hata koruması
        this.seats[seat] = true;
        player.seatIndex = seat;

        // Host ataması
        if (this.state.players.size === 0) {
            player.isHost = true;
            this.state.hostId = client.sessionId;
        }

        this.state.players.set(client.sessionId, player);
        this.broadcast("notification", `${player.name} MASAYA OTURDU.`);
    }

    onLeave(client) {
        const p = this.state.players.get(client.sessionId);
        if(p) this.seats[p.seatIndex] = false; // Koltuğu boşalt
        this.state.players.delete(client.sessionId);

        // Host çıktıysa yeni host ata
        if (client.sessionId === this.state.hostId && this.state.players.size > 0) {
            const nextId = this.state.players.keys().next().value;
            this.state.players.get(nextId).isHost = true;
            this.state.hostId = nextId;
            this.broadcast("notification", "HOST DEĞİŞTİ.");
        }
    }

    setupGame() {
        const colors = ["red", "blue", "green", "yellow"];
        const values = ["0","1","2","3","4","5","6","7","8","9","skip","reverse","+2"];
        let deck = [];
        colors.forEach(c => {
            values.forEach(v => deck.push(new Card(c, v)));
            deck.push(new Card("black", "wild"));
        });
        
        // Karıştır
        deck.sort(() => Math.random() - 0.5);

        // Dağıt
        this.state.players.forEach(p => {
            p.hand.clear();
            for(let i=0; i<7; i++) p.hand.push(deck.pop());
        });

        let top = deck.pop();
        while(top.color === "black") top = deck.pop();
        this.state.topCard = top;

        this.state.playerKeys = Array.from(this.state.players.keys());
        this.state.turnIndex = 0;
        this.state.currentTurn = this.state.playerKeys[0];
        this.state.gameStatus = "PLAYING";
        
        this.broadcast("start_game");
    }

    handlePlay(client, data) {
        if(this.state.currentTurn !== client.sessionId) return;
        const p = this.state.players.get(client.sessionId);
        const card = p.hand[data.index];
        const top = this.state.topCard;

        if (card.color === "black" || card.color === top.color || card.value === top.value) {
            p.hand.splice(data.index, 1);
            if(data.color) card.color = data.color;
            this.state.topCard = new Card(card.color, card.value);
            
            if(p.hand.length === 0) {
                this.broadcast("notification", `${p.name} KAZANDI!`);
                this.broadcast("game_over", p.name);
            } else {
                this.nextTurn();
            }
        }
    }

    handleDraw(client) {
        if(this.state.currentTurn !== client.sessionId) return;
        // Demo için rastgele kart
        const colors = ["red", "blue", "green", "yellow"];
        const c = colors[Math.floor(Math.random()*4)];
        const v = Math.floor(Math.random()*9).toString();
        this.state.players.get(client.sessionId).hand.push(new Card(c,v));
        this.nextTurn();
    }

    handleRoulette(client, res) {
        if(res === "dead") {
            const p = this.state.players.get(client.sessionId);
            p.isDead = true;
            this.broadcast("notification", `${p.name} ELENDİ.`);
        }
        this.nextTurn();
    }

    nextTurn() {
        let attempts = 0;
        do {
            this.state.turnIndex = (this.state.turnIndex + 1) % this.state.playerKeys.length;
            const nextId = this.state.playerKeys[this.state.turnIndex];
            const p = this.state.players.get(nextId);
            if(p && !p.isDead) {
                this.state.currentTurn = nextId;
                return;
            }
            attempts++;
        } while(attempts < this.state.players.size);
    }
}

const app = express();
app.use(cors());
app.use(express.json());
app.get('/healthz', (req, res) => res.send('OK'));

const server = http.createServer(app);
const gameServer = new Server({ server: server });
gameServer.define("high_stakes_room", HighStakesRoom).enableRealtimeListing();

server.listen(process.env.PORT || 3000, () => console.log("Server Ready"));
