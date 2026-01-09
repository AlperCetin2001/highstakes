const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server, Room } = require('colyseus');
const { Schema, MapSchema, ArraySchema, type } = require('@colyseus/schema');

// --- 1. VERİ YAPILARI (SCHEMA) ---
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
    }
}
type([Card])(Player.prototype, "hand");
type("string")(Player.prototype, "name");

class GameState extends Schema {
    constructor() {
        super();
        this.players = new MapSchema();
        this.deck = new ArraySchema();
        this.discardPile = new ArraySchema();
        this.currentTurn = "";
        this.gameStatus = "LOBBY"; // LOBBY, PLAYING, ROULETTE
        this.turnIndex = 0;
    }
}
type({ map: Player })(GameState.prototype, "players");
type([Card])(GameState.prototype, "discardPile");
type("string")(GameState.prototype, "currentTurn");
type("string")(GameState.prototype, "gameStatus");
type(Card)(GameState.prototype, "topCard");

// --- 2. OYUN MANTIĞI (ROOM) ---
class HighStakesRoom extends Room {
    onCreate(options) {
        this.setState(new GameState());
        this.maxClients = 4;

        // Mesajları Dinle
        this.onMessage("start_game", (client) => {
            if(this.state.players.size >= 2) this.setupGame();
            else this.broadcast("notification", "EN AZ 2 OYUNCU GEREKLİ!");
        });

        this.onMessage("play_card", (client, data) => {
            if (this.state.currentTurn !== client.sessionId) return;
            if (this.state.gameStatus !== "PLAYING") return;

            const player = this.state.players.get(client.sessionId);
            const card = player.hand[data.index];
            const top = this.state.topCard;

            // Uno Kural Kontrolü
            let isValid = false;
            if (card.color === "black") isValid = true; // Joker her zaman oynanır
            else if (card.color === top.color || card.value === top.value) isValid = true;

            if (isValid) {
                // Kartı elden çıkar
                player.hand.splice(data.index, 1);
                
                // Eğer Jokerse rengi değiştir
                if(data.color) card.color = data.color;
                
                this.state.topCard = new Card(card.color, card.value);
                this.state.discardPile.push(this.state.topCard);

                // Kontrol: Kart bitti mi?
                if (player.hand.length === 0) {
                    this.broadcast("notification", `${player.name} KAZANDI!`);
                    this.state.gameStatus = "LOBBY";
                    return;
                }

                // Özel Kartlar
                if(card.value === "skip") this.nextTurn(); 
                // (Reverse 2 kişiyle skip gibidir)
                
                this.nextTurn();
            }
        });

        this.onMessage("draw_card", (client) => {
            if (this.state.currentTurn !== client.sessionId) return;
            this.drawCard(client.sessionId, 1);
            this.nextTurn();
        });

        this.onMessage("roulette_result", (client, result) => {
            if(result === "dead") {
                this.broadcast("notification", `${this.state.players.get(client.sessionId).name} ELENDİ!`);
                // Reset game logic here if needed
            } else {
                this.broadcast("notification", "TETİK BOŞ ÇIKTI. OYUN DEVAM EDİYOR.");
                this.state.gameStatus = "PLAYING";
                this.nextTurn();
            }
        });
    }

    onJoin(client, options) {
        console.log(client.sessionId, "katıldı.");
        const player = new Player();
        player.name = options.name || "Drifter " + Math.floor(Math.random()*100);
        this.state.players.set(client.sessionId, player);
        
        this.broadcast("notification", `${player.name} GİRİŞ YAPTI.`);
    }

    onLeave(client) {
        this.state.players.delete(client.sessionId);
        this.broadcast("notification", "BİR OYUNCU AYRILDI.");
    }

    setupGame() {
        // Deste Oluştur
        const colors = ["red", "blue", "green", "yellow"];
        const values = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "skip", "reverse", "+2"];
        const deck = [];
        
        colors.forEach(c => {
            values.forEach(v => deck.push(new Card(c, v)));
            deck.push(new Card(c, "wild")); // Her renkten bir joker gibi düşünelim
        });
        
        // Karıştır
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        
        // Dağıt (7 Kart)
        this.state.players.forEach(player => {
            player.hand.clear();
            for(let i=0; i<7; i++) player.hand.push(deck.pop());
        });

        // Ortaya Aç
        let top = deck.pop();
        while(top.color === "black") top = deck.pop(); // İlk kart joker olmasın
        this.state.topCard = top;
        this.state.discardPile.push(top);

        this.state.deck = new ArraySchema(...deck); // Kalanlar
        
        // Sıra Belirle
        this.state.playerKeys = Array.from(this.state.players.keys());
        this.state.turnIndex = 0;
        this.state.currentTurn = this.state.playerKeys[0];
        this.state.gameStatus = "PLAYING";

        this.broadcast("start_game");
        this.broadcast("notification", "OYUN BAŞLADI!");
    }

    drawCard(sessionId, amount) {
        const player = this.state.players.get(sessionId);
        for(let i=0; i<amount; i++) {
            // Deste bittiyse (Basitçe yeniden oluşturmuyoruz, demo olduğu için sanal kart veriyoruz)
            const colors = ["red", "blue", "green", "yellow"];
            const values = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
            const c = colors[Math.floor(Math.random()*4)];
            const v = values[Math.floor(Math.random()*9)];
            player.hand.push(new Card(c, v));
        }
    }

    nextTurn() {
        this.state.turnIndex = (this.state.turnIndex + 1) % this.state.playerKeys.length;
        this.state.currentTurn = this.state.playerKeys[this.state.turnIndex];
    }
}

// --- 3. SUNUCU BAŞLATMA ---
const app = express();
app.use(cors());
app.use(express.json());

// Keep-Alive Endpoint
app.get('/healthz', (req, res) => res.send('OK'));

const server = http.createServer(app);
const gameServer = new Server({ server: server });

gameServer.define("high_stakes_room", HighStakesRoom);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
