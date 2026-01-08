const colyseus = require("colyseus");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Schema, MapSchema, type } = require("@colyseus/schema");

// 1. OYUN STATE (DURUM) YAPISI
class Player extends Schema {
    constructor(name) {
        super();
        this.name = name;
        this.credits = 1000; // Başlangıç parası
        this.isAlive = true;
    }
}
type("string")(Player.prototype, "name");
type("number")(Player.prototype, "credits");
type("boolean")(Player.prototype, "isAlive");

class GameState extends Schema {
    constructor() {
        super();
        this.players = new MapSchema();
        this.turn = "";
    }
}
type({ map: Player })(GameState.prototype, "players");
type("string")(GameState.prototype, "turn");

// 2. ODA MANTIĞI
class HighStakesRoom extends colyseus.Room {
    
    onCreate(options) {
        // Rastgele 4 haneli oda ID'si oluştur (Örn: AB12)
        this.roomId = this.generateRoomId();
        this.setState(new GameState());
        
        console.log("Masa açıldı:", this.roomId);

        this.onMessage("action", (client, message) => {
            // Oyun içi hamleler buraya gelecek (Kart atma, Tetik çekme vs.)
            console.log(client.sessionId, "bir hamle yaptı:", message);
        });
    }

    onJoin(client, options) {
        console.log(client.sessionId, "masaya oturdu.");
        const player = new Player(options.name || "Drifter");
        this.state.players.set(client.sessionId, player);
    }

    onLeave(client) {
        console.log(client.sessionId, "masadan kalktı.");
        this.state.players.delete(client.sessionId);
    }

    generateRoomId() {
        // Sadece harf ve rakamdan oluşan 4 haneli kod
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let result = "";
        for (let i = 0; i < 4; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
}

// 3. SUNUCU BAŞLATMA
const app = express();
app.use(cors());
const gameServer = new colyseus.Server({
    server: http.createServer(app)
});

// Odayı tanımla
gameServer.define("high_stakes_room", HighStakesRoom);

const port = process.env.PORT || 2567;
gameServer.listen(port);
console.log(`High Stakes Sunucusu ${port} portunda çalışıyor...`);
