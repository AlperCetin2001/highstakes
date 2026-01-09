const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server, Room } = require('colyseus');
const { Schema, MapSchema, ArraySchema, type } = require('@colyseus/schema');

// --- 1. VERİ ŞEMALARI (DATA LAYER) ---
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
        this.seatIndex = -1;
        this.isReady = false;
    }
}
type([Card])(Player.prototype, "hand");
type("string")(Player.prototype, "name");
type("boolean")(Player.prototype, "isHost");
type("number")(Player.prototype, "seatIndex");

class GameState extends Schema {
    constructor() {
        super();
        this.players = new MapSchema();
        this.currentTurn = "";
        this.gameStatus = "LOBBY"; // LOBBY, PLAYING, ROULETTE, GAMEOVER
        this.topCard = new Card("black", "wild");
        this.deck = new ArraySchema();
        this.lastWinner = "";
    }
}
type({ map: Player })(GameState.prototype, "players");
type("string")(GameState.prototype, "currentTurn");
type("string")(GameState.prototype, "gameStatus");
type(Card)(GameState.prototype, "topCard");
type("string")(GameState.prototype, "lastWinner");

// --- 2. OYUN ODASI MANTIĞI (LOGIC LAYER) ---
class CyberRoom extends Room {
    onCreate(options) {
        this.maxClients = 4;
        this.setState(new GameState());
        this.playerSlots = [false, false, false, false]; // 4 Koltuk

        // OYUNU BAŞLAT
        this.onMessage("start_game", (client) => {
            const player = this.state.players.get(client.sessionId);
            if (player && player.isHost && this.state.players.size >= 2) {
                this.lock(); // Odayı kilitle
                this.setupGame();
            }
        });

        // KART OYNAMA
        this.onMessage("play_card", (client, data) => {
            if (this.state.gameStatus !== "PLAYING") return;
            if (this.state.currentTurn !== client.sessionId) return;

            const player = this.state.players.get(client.sessionId);
            const card = player.hand[data.index];
            
            // Kural Kontrolü
            const top = this.state.topCard;
            let valid = (card.color === 'black') || (card.color === top.color) || (card.value === top.value);

            if (valid) {
                // Kartı oyna
                player.hand.splice(data.index, 1);
                if(data.color) card.color = data.color; // Renk değişimi
                this.state.topCard = new Card(card.color, card.value);

                // Kazanma Kontrolü
                if(player.hand.length === 0) {
                    this.state.gameStatus = "GAMEOVER";
                    this.state.lastWinner = player.name;
                    this.broadcast("notification", `${player.name} KAZANDI!`, "success");
                    // 5 saniye sonra lobiye dön
                    this.clock.setTimeout(() => this.resetLobby(), 5000);
                    return;
                }

                // Özel Kartlar
                if (card.value === "skip" || card.value === "reverse") {
                    this.nextTurn(); // 2 kişide reverse = skip
                }
                
                this.nextTurn();
            }
        });

        // KART ÇEKME
        this.onMessage("draw_card", (client) => {
            if (this.state.currentTurn !== client.sessionId) return;
            this.giveCardTo(client.sessionId);
            this.nextTurn();
        });

        // RUS RULETİ TETİK
        this.onMessage("trigger_pull", (client) => {
            if (this.state.gameStatus !== "ROULETTE") return;
            
            // %16 Ölme İhtimali
            const dead = Math.random() < 0.16;
            
            this.broadcast("roulette_result", { id: client.sessionId, dead: dead });
            
            if(dead) {
                this.broadcast("notification", `${this.state.players.get(client.sessionId).name} ELENDİ.`, "danger");
                // Oyuncuyu at veya izleyici yap (Basitlik için el boşaltıyoruz)
                this.state.players.get(client.sessionId).hand.clear();
                this.nextTurn();
                this.state.gameStatus = "PLAYING";
            } else {
                this.broadcast("notification", "BOŞ! ŞANSLI GÜNÜNDESİN.", "success");
                this.state.gameStatus = "PLAYING";
                this.nextTurn();
            }
        });
    }

    onJoin(client, options) {
        console.log("Giriş:", client.sessionId);
        const player = new Player();
        player.name = (options.name || "Ajan").substring(0, 12);
        
        // Host Belirleme
        if (this.state.players.size === 0) player.isHost = true;

        // Koltuk Atama
        const seat = this.playerSlots.findIndex(s => s === false);
        this.playerSlots[seat] = true;
        player.seatIndex = seat;

        this.state.players.set(client.sessionId, player);
        this.broadcast("notification", `${player.name} BAĞLANDI.`, "info");
    }

    onLeave(client) {
        const player = this.state.players.get(client.sessionId);
        if(player) {
            this.playerSlots[player.seatIndex] = false; // Koltuğu boşalt
            
            // Host çıktıysa devret
            if(player.isHost && this.state.players.size > 1) {
                this.state.players.forEach(p => {
                    if(p !== player && !p.isHost) {
                        p.isHost = true; // İlk bulduğuna ver
                        this.broadcast("notification", `YENİ LİDER: ${p.name}`);
                    }
                });
            }
        }
        this.state.players.delete(client.sessionId);
        
        // Oda boşsa kapat (Render otomatik yapar ama biz de temizleyelim)
        if(this.state.players.size === 0) this.disconnect();
    }

    setupGame() {
        // Deste Oluştur
        const colors = ["red", "blue", "green", "yellow"];
        const vals = ["0","1","2","3","4","5","6","7","8","9","skip","reverse","+2"];
        const deck = [];
        colors.forEach(c => {
            vals.forEach(v => deck.push(new Card(c, v)));
            deck.push(new Card("black", "wild"));
        });
        
        // Karıştır (Fisher-Yates)
        for(let i=deck.length-1; i>0; i--) {
            const j = Math.floor(Math.random()*(i+1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }

        // Dağıt
        this.state.players.forEach(p => {
            p.hand.clear();
            for(let k=0; k<5; k++) p.hand.push(deck.pop());
        });

        // Ortaya Aç
        let top = deck.pop();
        while(top.color === 'black') top = deck.pop();
        this.state.topCard = top;

        // Sıra
        this.playerKeys = Array.from(this.state.players.keys());
        this.turnIndex = 0;
        this.state.currentTurn = this.playerKeys[0];
        this.state.gameStatus = "PLAYING";
        
        this.broadcast("start_game_client");
    }

    giveCardTo(sessionId) {
        const p = this.state.players.get(sessionId);
        const colors = ["red", "blue", "green", "yellow"];
        // Sanal deste (Sonsuz)
        p.hand.push(new Card(colors[Math.floor(Math.random()*4)], Math.floor(Math.random()*9).toString()));
    }

    nextTurn() {
        this.playerKeys = Array.from(this.state.players.keys());
        this.turnIndex = (this.turnIndex + 1) % this.playerKeys.length;
        this.state.currentTurn = this.playerKeys[this.turnIndex];
    }

    resetLobby() {
        this.state.gameStatus = "LOBBY";
        this.unlock(); // Odayı tekrar görünür yap
        this.broadcast("return_lobby");
    }
}

// --- 3. SERVER INIT ---
const app = express();
app.use(cors());
app.use(express.json());
app.get('/healthz', (req, res) => res.send('OK'));

const server = http.createServer(app);
const gameServer = new Server({ server });

gameServer.define("cyber_room", CyberRoom).enableRealtimeListing();

server.listen(process.env.PORT || 3000, () => console.log("CYBER CORE ONLINE"));
