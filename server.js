const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server, Room } = require('colyseus');
const { Schema, MapSchema, ArraySchema, type } = require('@colyseus/schema');

// --- SCHEMA (VERİ YAPISI) ---
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
        this.name = "Player";
        this.isReady = false;
    }
}
type([Card])(Player.prototype, "hand");
type("string")(Player.prototype, "name");
type("boolean")(Player.prototype, "isReady");

class GameState extends Schema {
    constructor() {
        super();
        this.players = new MapSchema();
        this.deck = new ArraySchema();
        this.discardPile = new ArraySchema();
        this.currentTurn = "";
        this.gameStatus = "LOBBY"; // LOBBY, PLAYING
        this.hostSessionId = ""; // Odayı kuran kişi
    }
}
type({ map: Player })(GameState.prototype, "players");
type([Card])(GameState.prototype, "discardPile");
type("string")(GameState.prototype, "currentTurn");
type("string")(GameState.prototype, "gameStatus");
type("string")(GameState.prototype, "hostSessionId");
type(Card)(GameState.prototype, "topCard");

// --- ODA MANTIĞI ---
class HighStakesRoom extends Room {
    onCreate(options) {
        this.maxClients = 4; // MAKSİMUM 4 KİŞİ
        this.setState(new GameState());

        this.onMessage("start_game", (client) => {
            // Sadece Host başlatabilir ve en az 2 kişi lazım
            if (client.sessionId === this.state.hostSessionId && this.state.players.size >= 2) {
                this.setupGame();
                this.lock(); // ODAYI KİLİTLE (Artık listede görünmez)
            }
        });

        this.onMessage("play_card", (client, data) => {
            if (this.state.currentTurn !== client.sessionId) return;
            this.handleCardPlay(client, data);
        });

        this.onMessage("draw_card", (client) => {
            if (this.state.currentTurn !== client.sessionId) return;
            this.drawCard(client.sessionId, 1);
            this.nextTurn();
        });
        
        this.onMessage("roulette_result", (client, result) => {
             // Rulet mantığı buraya (Önceki kodlardaki gibi)
             this.broadcast("notification", result === "dead" ? "OYUNCU ELENDİ!" : "ŞANSLI GÜNÜNDESİN.");
             if(result !== "dead") this.nextTurn();
        });
    }

    onJoin(client, options) {
        console.log("Katıldı:", client.sessionId);
        const player = new Player();
        player.name = options.name || `Oyuncu ${this.clients.length}`;
        this.state.players.set(client.sessionId, player);

        // İlk giren Host olur
        if (this.state.players.size === 1) {
            this.state.hostSessionId = client.sessionId;
        }

        this.broadcast("notification", `${player.name} KATILDI.`);
    }

    onLeave(client) {
        this.state.players.delete(client.sessionId);
        // Eğer Host çıktıysa, odayı sonraki kişiye devret veya kapat (Basitlik için kapatmıyoruz)
    }

    setupGame() {
        // UNO DESTE MANTIĞI
        const colors = ["red", "blue", "green", "yellow"];
        const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "+2"];
        const deck = [];
        colors.forEach(c => {
            values.forEach(v => deck.push(new Card(c, v)));
            deck.push(new Card("black", "wild"));
        });
        
        // Karıştır
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }

        // Dağıt
        this.state.players.forEach(p => {
            for(let i=0; i<7; i++) p.hand.push(deck.pop());
        });

        // Ortaya Aç
        let top = deck.pop();
        while(top.color === "black") top = deck.pop();
        this.state.topCard = top;
        this.state.discardPile.push(top);
        
        // Sıra
        this.state.playerKeys = Array.from(this.state.players.keys());
        this.state.turnIndex = 0;
        this.state.currentTurn = this.state.playerKeys[0];
        this.state.gameStatus = "PLAYING";

        this.broadcast("start_game");
    }

    handleCardPlay(client, data) {
        const player = this.state.players.get(client.sessionId);
        const card = player.hand[data.index];
        const top = this.state.topCard;

        let isValid = (card.color === "black") || (card.color === top.color || card.value === top.value);
        
        if (isValid) {
            player.hand.splice(data.index, 1);
            if(data.color) card.color = data.color; // Joker renk seçimi
            this.state.topCard = new Card(card.color, card.value);
            this.state.discardPile.push(this.state.topCard);
            
            if(player.hand.length === 0) {
                this.broadcast("notification", `${player.name} KAZANDI!`);
                // Oyunu bitir veya lobiye dön
            } else {
                this.nextTurn();
            }
        }
    }

    drawCard(sid, amount) {
        const p = this.state.players.get(sid);
        // Basitlik için rastgele kart veriyoruz (Deste biterse diye)
        const colors = ["red", "blue", "green", "yellow"];
        const c = colors[Math.floor(Math.random()*4)];
        const v = Math.floor(Math.random()*9).toString();
        p.hand.push(new Card(c, v));
    }

    nextTurn() {
        this.state.turnIndex = (this.state.turnIndex + 1) % this.state.playerKeys.length;
        this.state.currentTurn = this.state.playerKeys[this.state.turnIndex];
    }
}

const app = express();
app.use(cors());
app.use(express.json());
app.get('/healthz', (req, res) => res.send('OK')); // Keep-alive

const server = http.createServer(app);
const gameServer = new Server({ server: server });

// "high_stakes_room" adıyla odayı tanımlıyoruz
gameServer.define("high_stakes_room", HighStakesRoom)
    .enableRealtimeListing(); // LİSTELEMEYİ AKTİF ET (ÖNEMLİ)

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on ${PORT}`));
