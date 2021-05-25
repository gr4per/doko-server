const express = require('express');
const ws = require('ws');
const url = require('url');
const querystring = require('querystring');
const fs = require('fs');
const { BlobServiceClient } = require("@azure/storage-blob");
const {setupUniqueCards, shuffle, isCardLegal, isTrumpf, compareTrumpf, compareFehl, isSchweinerei, prettyPrint, getPossibleNextAnnouncement, getKlaerungsstich, getPlayerParty, pflichtsoloGespielt} = require("./cardUtils.js");
const allCards = require("./allCards");
const {sleep, getUniqueId} = require("./genericUtil.js");
let serverPort = process.env.PORT;
if(!serverPort)serverPort=3000;
const app = express();
const bodyParser = require('body-parser');
const cors = require('cors');
app.use(cors());
app.use(bodyParser.json());
const playerConnections = [];

let playerCreds = process.env.creds; // object mapping playerId to {pass:...., token:....}
if(playerCreds) {
  playerCreds = JSON.parse(playerCreds);
}
let storageAccountUrl = process.env.saConnStr;
let blobServiceClient = null;
let containerClient = null;
if(storageAccountUrl) {
  blobServiceClient = BlobServiceClient.fromConnectionString(storageAccountUrl);
  console.log("opened blob service client");
  if(blobServiceClient) {
    containerClient = blobServiceClient.getContainerClient("dokodata");
    console.log("opened container client");
  }
}

let uidCounter = 0;
function getPlayerConnectionId() {
  return uidCounter++;
}

// Set up a headless websocket server that prints any
// events that come in.
function formatSocket(socket) {
  return " port " + socket.localPort + " from remote " + socket.remoteAddress;
}

function noop() {}

const wsServer = new ws.Server({ noServer: true });
wsServer.on('connection', (ws, request) => {
  console.log("connection event on wsServer, socket : " + formatSocket(request.socket));
  
  let playerConnection = playerConnections.find(e=>{return e.socket == ws;});
  playerConnection.sendError = (error) => {
    console.log("sending error tp player " + playerConnection.playerId + ": " + error);
    ws.send(JSON.stringify({error:error}));
  };
  if(!playerConnection) {
    console.error("failed to locate playerConnection on socket " + formatSocket(request.socket));
    ws.destroy();
    return;
  }
  console.log("found playerConnection["+playerConnection.id+"], playerId " + playerConnection.playerId + ", gameId " + playerConnection.gameId);
  ws.send(JSON.stringify({command:"id",params:[playerConnection.id]}));
  if(playerConnection.error) {
    console.log("playerConnection is in error state, sending error to client before socket termination.");
    ws.send(JSON.stringify({error:playerConnection.error}));
    removePlayer(playerConnection);
  }
  ws.on('error', (e) => {
      console.log("received error on websocket of player " + playerConnection.playerId + ", connected to game " + playerConnection.gameId + ": " + e);
      playerConnection.error = e;
  });
  ws.on('pong', (e) => {
    //console.log("received pong from playerConnection of " + playerConnection.playerId);
    playerConnection.isAlive=true;
  });
  ws.on('message', message => {
    //console.log("rcvd msg from " + playerConnection.playerId + ": " + message);
    let messageObj = JSON.parse(message);
    switch(messageObj.command) {
      case "clientPing":
        playerConnection.isAlive=true;
        ws.send(JSON.stringify({command:"pong"}));
        break;
      case "leave":
        console.log("player " + playerConnection.playerId + " is leaving game, remove from players = " + messageObj.params[0]);
        playerConnection.isAlive=false;
        removePlayer(playerConnection, messageObj.params[0]);
        break;
      case "revert":
        console.log("player " + playerConnection.playerId + " is asking to revert game " + playerConnection.gameId + "...");
        revertGame(playerConnection.gameId);
        break;
      case "reportHealth":
        reportHealth(playerConnection, messageObj.params.gameType, messageObj.params.gameSubType);
        break;
      case "playCard":
        playCard(playerConnection, messageObj.params[0]);
        break;
      case "acceptScore":
        acceptScore(playerConnection, messageObj.params[0]);
        break;
      case "chat":
        chat(playerConnection, messageObj.params[0]);
        break;
      case "viewLast":
        lastTrick(playerConnection);
        break;
      case "announce":
        announce(playerConnection, messageObj.params[0]);
        break;
      default:
        console.log("Not implemented! Received command " + messageObj.command + " from player " + playerConnection.playerId);
    }
  });
  playerConnection.status = "joined";
  updateGameState(playerConnection.gameId);
});

async function lastTrick(playerConnection) {
  let game = gamesList[playerConnection.gameId];
  if(game.gameStatus != "running") {
    console.log("cannot view last trick when game is not running");
    return;
  }
  let round = game.rounds[game.currentRound];
  let completedTricks = round.tricks.filter(t=>{return t.winnerIdx >-1;});
  if(completedTricks.length == 0) {
    console.log("no tricks played that can be viewed");
    return;
  }
  if(game.viewLastTrickIdx != null) {
    game.viewLastTrickIdx = null;
    console.log("" + playerConnection.playerId + " hat genug gesehen.");
  }
  else {
    gameLog(playerConnection.gameId, null, "" + playerConnection.playerId + " sieht sich den letzten Stich an.");
    game.viewLastTrickIdx = game.players.indexOf(playerConnection.playerId);
  }
  updateGameState(playerConnection.gameId);
}

async function chat(playerConnection, msg) {
  let strippedMsg = msg.replace(/</g,"&lt;");
  strippedMsg = msg.replace(/>/g,"&gt;");
  gameLog(playerConnection.gameId, playerConnection.playerId, msg);
  updateGameState(playerConnection.gameId);
}

async function announce(playerConnection, announcement) {
  if(["Re","Kontra","Keine 90","Keine 60", "Keine 30","Schwarz"].indexOf(announcement) == -1) {
    gameLog(playerConnection.gameId, null, "Spieler " + playerConnection.playerId + " versucht illegale Ansage: " + announcement);
    updateGameState(playerConnection.gameId);
    return;
  }
  let game = gamesList[playerConnection.gameId];
  if(!game) {
    console.log("Player " + playerConnection.playerId + " cannot announce on non existing game " + playerConnection.gameId);
    playerConnection.sendError("Spiel " + playerConnection.gameId + " nicht gefunden.");
    return;
  }
  console.log("game = " + game.gameId + ", players = " + JSON.stringify(game.players));
  let playerIdx = game.players.indexOf(playerConnection.playerId);
  if(playerIdx == -1) {
    console.log("Player " + playerConnection.playerId + " is not found in game " + playerConnection.gameId);
    playerConnection.sendError("Spieler " + playerConnection.playerId + " nimmt an Spiel " + playerConnection.gameId + " nicht teil.");
    return;
  }
  console.log("playerIdx = " + playerIdx);
  if(game.gameStatus != "running") {
    console.log("Player " + playerConnection.playerId + " cannot announce on non running game " + playerConnection.gameId);
    playerConnection.sendError("Spiel " + playerConnection.gameId + " ist nicht in einer aktiven Runde und erlaubt daher zu diesem Zeitpunkt keine Ansagen.");
    return;
  }
  console.log("checking possible announcement for game " + playerConnection.gameId + ", player " + playerConnection.playerId + "[" + playerIdx+ "], trying to announce " + announcement + ".");
  let nextAnnouncement = getPossibleNextAnnouncement(game, playerIdx);
  if(nextAnnouncement == null) {
    console.log("Player " + playerConnection.playerId + " cannot make any announcements in game " + playerConnection.gameId + " at this time.");
    playerConnection.sendError("Es gibt momentan keine legalen Ansageoptionen für Spieler " +playerConnection.playerId + " in Spiel " + playerConnection.gameId + ".");
    return;
  }
  if(nextAnnouncement != announcement) {
    console.log("Player " + playerConnection.playerId + " cannot announcements " + announcement + " in game " + playerConnection.gameId + ", next legal option is " + nextAnnouncement);
    playerConnection.sendError("Spieler " +playerConnection.playerId + " kann in Spiel " + playerConnection.gameId + " nicht '" + announcement + "' ansagen. Ansageoption ist " + nextAnnouncement);
    return;
  }
  gameLog(playerConnection.gameId, playerConnection.playerId, announcement);
  
  console.log("Player " + playerConnection.playerId + " announces " + announcement);
  let playerParty = getPlayerParty(game, playerIdx);
  let round = game.rounds[game.currentRound];
  if(playerParty == "Re" && round.rePlayers.indexOf(playerIdx) == -1) {
    console.log("Player " + playerConnection.playerId + " in Re party announces " + announcement + ", adding to rePlayers");
    addPlayerToParty(game, "Re", playerIdx);
  }    
  if(playerParty == "Kontra" && round.kontraPlayers.indexOf(playerIdx) == -1) {
    console.log("Player " + playerConnection.playerId + " in Kontra party announces " + announcement + ", adding to kontraPlayers");
    addPlayerToParty(game, "Kontra", playerIdx);
  }
  if(round.announcements[playerIdx].indexOf(playerParty) == -1 && announcement != playerParty) {
    round.announcements[playerIdx].push(playerParty); 
  }
  round.announcements[playerIdx].push(announcement); 
  updateGameState(playerConnection.gameId);
}


async function acceptScore(playerConnection, ok) {
  console.log("Player " + playerConnection.playerId + " accepts score: " + ok);
  let game = gamesList[playerConnection.gameId];
  if(game.rounds[game.currentRound].scoreAccepted[game.players.indexOf(playerConnection.playerId)] == true){
    console.log("player "  +playeConnection.playerId + " already accepted score!");
    playerConnection.sendError(err);
    return;
  }
  game.rounds[game.currentRound].scoreAccepted[game.players.indexOf(playerConnection.playerId)] = ok;
  await updateGameState(playerConnection.gameId);
  if(game.rounds[game.currentRound].scoreAccepted.filter(e=>{return e==true;}).length == 4) {
    console.log("All players accepted");
    if(game.currentRound == game.rounds.length-1) {
      console.log("last round finished, resolving game");
      return await resolveGame(game);
    }
    console.log("starting next round");
    await sleep(1000);
    game.currentRound++;
    
    await startRound(game.gameId);
  }
}

async function resolveGame(game) {
  console.log("creating new game");
  let prevInstance = game.instance;
  let players = game.players;
  let playerState = game.playerState;
  for(let p of Object.values(playerState)) {
    p.discardPile = [];
  }
  game = createGame(game.gameId, 16);
  game.players = players;
  game.startTime = new Date().getTime();
  game.playerState = playerState;
  game.instance = prevInstance+1;
  gamesList[game.gameId] = game;
  await saveGame(game);
  await updateGameState(game.gameId);
  startGame(game.gameId);
}

function getCurrentRound(game) {
  return game.rounds[game.currentRound];
}

async function addPlayerToParty(game, party, playerIdx) {
  let round = game.rounds[game.currentRound];
  let players = (party == "Re")?round.rePlayers:round.kontraPlayers;
  
  players.push(playerIdx);
  if(players.length == 2) {
    gameLog(game.gameId, null, "Die Parteien sind nun vollständig geklärt.");
    if(party == "Re") {
      round.kontraPlayers = [0,1,2,3].filter(e=>{return round.rePlayers.indexOf(e) == -1;});
    }
    else {
      round.rePlayers = [0,1,2,3].filter(e=>{return round.kontraPlayers.indexOf(e) == -1;});
    }
    for(let t of round.tricks.filter(t=>{return t.cardIds.length == 4;})) {
      // Füchse nochmal überprüfen und ggf. einpacken...
      console.log("validating trick " + JSON.stringify(t.cardIds));
      validateFuechse(game, t);
    }
  }
}

async function playCard(playerConnection, cardId) {
  let game = gamesList[playerConnection.gameId];
  if(game.gameStatus != "running") {
    playerConnection.sendError("cannot accept card play, game not in running phase");
    return;
  }
  console.log("" + playerConnection.playerId + " plays card " + cardId);
  let round = getCurrentRound(game);
  let currentPlayerIdx = game.players.indexOf(playerConnection.playerId);
  console.log("currentPlayerIdx = " + currentPlayerIdx);
  if(currentPlayerIdx < 0) {
    playerConnection.sendError("playerId " + playerConnection.playerId + " not found in game " + gameId);
    return;
  }
  let err = isCardLegal(game, playerConnection.playerId, cardId);
  if(err != null) {
    playerConnection.sendError(err);
    return;
  }
  let player = game.playerState[playerConnection.playerId];
  let card = player.hand.find(c=>{return c.id == cardId;});
  // nothing prevents playing the card.
  //gameLog(playerConnection.gameId, playerConnection.playerId, "" + playerConnection.playerId + " spielt " + prettyPrint(game, card));
  console.log("" + playerConnection.playerId + " spielt " + prettyPrint(game, card));
  if(["gesund"].indexOf(round.gameType) > -1 && card.id == "eichel-ober") {
    if(round.rePlayers.indexOf(currentPlayerIdx) == -1) {
      gameLog(game.gameId, null, playerConnection.playerId + " gibt sich als Re zu erkennen.");
      addPlayerToParty(game, "Re", currentPlayerIdx);
    }
    else if(round.rePlayers.length == 1){ // player is Re, but catch special case that it is second Eichel Ober -> Stille Hochzeit
      let eichelOberPlayedBefore = false;
      if(game.turnCards.find(c=>{return c.type=="eichel" && c.subtype == "ober";}))eichelOberPlayedBefore = true;
      for(let t of round.tricks) {
        if(t.cardIds && t.cardIds.find(c=>{return c == "eichel-ober";})) {
          eichelOberPlayedBefore = true;
          break;
        }
      }
      if(eichelOberPlayedBefore) {
        console.log("Zweiter Eichel-Ober von " + playerConnection.playerId + ", sieht nach stiller Hochzeit aus...");
        round.kontraPlayers = [0,1,2,3].filter(p=>{return round.rePlayers.indexOf(p) == -1;});
      }
    }
  }
  game.turnCards.push(card);
  let trick = round.tricks[round.tricks.length-1];
  trick.cardIds.push(card.id);
  player.hand.splice(player.hand.indexOf(card),1);
  await updateGameState(playerConnection.gameId);
    
  // now check end of 
  if(game.turnCards.length == 4) {
    await sleep(3000);
    await resolveTrick(game);
  }
}

function validateFuechse(game, trick) {
  if(trick.cardIds.length < 4) return;
  console.log("validateFuechse, turnCards = " + JSON.stringify(game.turnCards));
  let originalFuchsCount = trick.extras.filter(e=>{return e == "Fuchs";}).length;
  trick.extras = trick.extras.filter(e=>{return e != "Fuchs";});
  let fuechse = [];
  let highestCard = null;
  for(let pos = 0; pos < 4; pos++) {
    let ownerIdx = trick.starterIdx +pos;
    if(ownerIdx > 3) ownerIdx-=4;
    let c = trick.cardIds[pos];
    if(ownerIdx == trick.winnerIdx) highestCard = c;
    if(c == "schellen-as") {
      fuechse.push({pos:pos, ownerIdx:ownerIdx});
    }
  }
  if(highestCard == "schellen-as") {
    fuechse.splice(0,1); // der erste Fuchs hat den Stich geholt, kann also nicht gefangen sein
  }
  let winnerParty = game.rounds[game.currentRound].rePlayers.indexOf(trick.winnerIdx) > -1?"Re":game.rounds[game.currentRound].kontraPlayers.indexOf(trick.winnerIdx) > -1?"Kontra":"Unbekannt";
  for(let f of fuechse) {
    let fuchsParty = game.rounds[game.currentRound].rePlayers.indexOf(f.ownerIdx) > -1?"Re":game.rounds[game.currentRound].kontraPlayers.indexOf(f.ownerIdx) > -1?"Kontra":"Unbekannt";
    if(winnerParty == "Unbekannt" || winnerParty != fuchsParty) {
     trick.extras.push("Fuchs");
    }
  }
  let newFuchsCount = trick.extras.filter(e=>{return e == "Fuchs";});
  if(newFuchsCount < originalFuchsCount) {
    gameLog(game.gameId, null, game.players[trick.winnerIdx] + " packt vermeintlich gefangenen Fuchs wieder ein.");
  }
}

async function resolveTrick(game) {
  let round = game.rounds[game.currentRound];
  let trick = round.tricks[round.tricks.length-1];
  let highestCard = game.turnCards[0];
  let winnerIdx = trick.starterIdx;
  
  let currentPlayerIdx = trick.starterIdx;
  let currentPlayerId = game.players[currentPlayerIdx];
  let firstCard = highestCard;
  let trumpf = isTrumpf(firstCard, round.gameType, round.gameSubType);
  for(let i = 1;i< 4;i++) {
    currentPlayerIdx++;
    if(currentPlayerIdx > 3)currentPlayerIdx-=4;
    currentPlayerId = game.players[currentPlayerIdx];
    
    if(trumpf) { // trumpf hoch
      if(isTrumpf(game.turnCards[i], round.gameType, round.gameSubType)){
        console.log("Trumpf ist hoch und Spieler hat ebenfalls Trumpf gespielt");
        let relativeValue = compareTrumpf(game.turnCards[i], highestCard,round.gameType,round.gameSubType);
        if(relativeValue < 0 || (relativeValue == 0 && highestCard.id == "herz-zehn" && ["gesund","hochzeit","farbsolo"].indexOf(round.gameType) > -1)) {
            console.log("Spieler " + currentPlayerId + " an Position " + (i+1) + " überstach " + highestCard.id + " mit " + game.turnCards[i].id);
            winnerIdx = currentPlayerIdx;
            highestCard = game.turnCards[i];
        }
        else {       
          console.log("Spieler " + currentPlayerId + " an Position " + (i+1) + " blieb mit " + game.turnCards[i].id + " drunter.");
        }
      }
      else {
        console.log("Trumpf ist hoch und Spieler wirft Fehl ab");
      }
    }
    else { // bisher ist fehl hoch
      if(isTrumpf(game.turnCards[i], round.gameType, round.gameSubType)) {
        console.log("Spieler " + currentPlayerId + " an Position " + (i+1) + " hat mit " + game.turnCards[i].id + " den Fehlstich abgestochen.");
        trumpf = true;
        highestCard = game.turnCards[i];
        winnerIdx = currentPlayerIdx;
      }
      else if(highestCard.type == game.turnCards[i].type) { // fehl der geforderten farbe
        if(compareFehl(game.turnCards[i], highestCard) < 0) {
          console.log("Spieler " + currentPlayerId + " an Position " + (i+1) + " übernahm den Fehlstich mit " + game.turnCards[i].id + ", bisher höchste Karte war " + highestCard.id);
          winnerIdx = currentPlayerIdx;
          highestCard = game.turnCards[i];
        }          
      }
    }
  }
  let winnerId = game.players[winnerIdx];
  gameLog(game.gameId, null, "Der Stich geht an " + winnerId + ".");
  trick.winnerIdx = winnerIdx;
  if(round.gameType == "hochzeit" && round.rePlayers.length == "1" && winnerIdx != round.rePlayers[0]) {
    console.log("Erster fremder! Hochzeit ist geklärt: " + game.players[round.rePlayers[0]] + " heiratet " + game.players[winnerIdx] + ".");
    round.rePlayers.push(winnerIdx);
    round.kontraPlayers = [0,1,2,3].filter(s => {return round.rePlayers.indexOf(s) == -1;});
  }
  
  // extrapunkte ?
  if(["gesund","hochzeit"].indexOf(round.gameType) > -1) {
    let augen = game.turnCards.reduce((ac,cv)=>{return ac+cv.value;},0);
    console.log("Der Stich hat " + augen + " Augen.");
    if(augen >= 40) {
      trick.extras.push("Doppelkopf");
      console.log("Extrapunkt! Der Stich war voll.");
      gameLog(game.gameId, null, winnerId + " hat einen Vollen geholt.");
    }
    if(round.tricks.length == 10 && highestCard.id == "eichel-unter") {
      trick.extras.push("Karlchen");
      gameLog(game.gameId, null, winnerId + " holt den letzten Stich mit einem Karlchen.");
    }
    let karlchenCount = game.turnCards.filter(c=>{return c.type=="eichel" && c.subtype == "unter";}).length;
    console.log("karlchenCount = " + karlchenCount);
    console.log("trumpf = " + trumpf);
    console.log("tricks.length = " + round.tricks.length);
    if(trumpf && round.tricks.length == 10 && karlchenCount > 0) {
      let karlchens = [];
      for(let i = 0; i < game.turnCards.length;i++) {
        let ownerIdx = trick.starterIdx+i;
        if(ownerIdx > 3) ownerIdx-=4;
        let c = game.turnCards[i];
        if(c.id == "eichel-unter") {
          karlchens.push({pos:i, ownerIdx:ownerIdx});
        }
      }
      console.log("Karlchens = " + JSON.stringify(karlchens));
      if(highestCard.id == "eichel-unter") {
        console.log("Trick was made by Karlchen, removing one from potentially caught ones.");
        karlchens.splice(0,1);
      }
      let winnerParty = game.rounds[game.currentRound].rePlayers.indexOf(winnerIdx) > -1?"Re":game.rounds[game.currentRound].kontraPlayers.indexOf(winnerIdx) > -1?"Kontra":"Unbekannt";
      console.log("winnerParty = " + winnerParty);
      for(let k of karlchens) {
        let karlchenParty = game.rounds[game.currentRound].rePlayers.indexOf(k.ownerIdx) > -1?"Re":game.rounds[game.currentRound].kontraPlayers.indexOf(k.ownerIdx) > -1?"Kontra":"Unbekannt";
        console.log("karlchenParty = " + karlchenParty);
        if(winnerParty == "Unbekannt" || winnerParty != karlchenParty) {
          trick.extras.push("Karlchen gefangen");
          gameLog(game.gameId, null, winnerId + " hat das Karlchen von " + game.players[k.ownerIdx] + " gefangen.");
        }
      }
    }
    if(trumpf && !isSchweinerei(game)) {
      validateFuechse(game, trick);
      let fuchsCount = trick.extras.filter(e=>{return e=="Fuchs";}).length;
      if(fuchsCount > 0) {
        gameLog(game.gameId, null, winnerId + " hat " + (fuchsCount == 1?"einen Fuchs":"zwei Füchse") + " gefangen.");
      }
    }
  }
  let winner = game.playerState[winnerId];
  winner.discardPile = winner.discardPile.concat(game.turnCards.splice(0,4));
  if(round.tricks.length < 10) {
    round.tricks.push({starterIdx:winnerIdx,cardIds:[],winnerIdx:-1,extras:[]});
  }
  else {
    console.log("reached end of round.");
    await resolveRound(game);
  }
  await saveGame(game);
  await updateGameState(game.gameId);
}

async function resolveRound(game) {
  gameLog(game.gameId, null, "Die Runde ist vorbei.");
  let round = getCurrentRound(game);
  let reScore = round.rePlayers.reduce((ac,p)=>{return ac + game.playerState[game.players[p]].discardPile.reduce((iac,c)=>{return iac+c.value;},0);},0);
  console.log("reScore = " + reScore);
  let kontraScore = round.kontraPlayers.reduce((ac,p)=>{return ac+game.playerState[game.players[p]].discardPile.reduce((iac,c)=>{return iac+c.value;},0);},0);
  console.log("kontraScore = " + kontraScore);
  if(reScore+kontraScore != 240) {
    console.error("Gesamtaugenzahl " + (reScore+kontraScore) + " != 240");
    process.exit(1);
  }
  let reAnnouncements = [];
  round.announcements.filter( 
    // return only arrays that belong to reParty members
    (e,idx)=>{return round.rePlayers.indexOf(idx) > -1;}
  ).map(
    // for each surviving announcement array, remove first element and add the others to reAnnouncement bucket
    (ra,idx)=>{
      ra.map((rai,idxi)=>{if(idxi>0)reAnnouncements.push(rai);})
    }
  );
  let kontraAnnouncements = [];
  round.announcements.filter( (e,idx)=>{return round.kontraPlayers.indexOf(idx) > -1;}).map((ra,idx)=>{ra.map((rai,idxi)=>{if(idxi>0)kontraAnnouncements.push(rai);})});
  console.log("Re hat angesagt: " + JSON.stringify(reAnnouncements));
  console.log("Kontra hat angesagt: " + JSON.stringify(kontraAnnouncements));
  let re = reAnnouncements.indexOf("Re") > -1;
  let kontra = kontraAnnouncements.indexOf("Kontra") > -1;
  let reAbsage = null;
  if(reAnnouncements.filter(e=>{return e!= "Re" && e!= "Schweine"}).length > 0) {
    if(reAnnouncements.indexOf("Schwarz")>-1) reAbsage = "Schwarz";
    else if(reAnnouncements.indexOf("Keine 30")>-1) reAbsage = "Keine 30";
    else if(reAnnouncements.indexOf("Keine 60")>-1) reAbsage = "Keine 60";
    else if(reAnnouncements.indexOf("Keine 90")>-1) reAbsage = "Keine 90";
  }
  let kontraAbsage = null;
  if(kontraAnnouncements.filter(e=>{return e!= "Kontra" && e!= "Schweine"}).length > 0) {
    if(kontraAnnouncements.indexOf("Schwarz")>-1) kontraAbsage = "Schwarz";
    else if(kontraAnnouncements.indexOf("Keine 30")>-1) kontraAbsage = "Keine 30";
    else if(kontraAnnouncements.indexOf("Keine 60")>-1) kontraAbsage = "Keine 60";
    else if(kontraAnnouncements.indexOf("Keine 90")>-1) kontraAbsage = "Keine 90";
  }
  console.log("Re angesagt: " + (re?"ja":"nein"));
  console.log("Kontra angesagt: " + (kontra?"ja":"nein"));
  console.log("Re absage " + (reAbsage?reAbsage:"nein"));
  console.log("Kontra absage " + (kontraAbsage?kontraAbsage:"nein"));
  
  let winnerParty = null;
  let gameScore = [];
  let winners = [];
  let reLost = false;
  let kontraLost = false;
  // https://doko-wissen.de/index.php?title=Spielbewertungsbeispiele
  if(reAbsage) {
    if(reAbsage == "Keine 90" && kontraScore >= 90) {
      reLost=true;
    }
    else if(reAbsage == "Keine 60" && kontraScore >= 60) {
      reLost=true;
    }
    else if(reAbsage == "Keine 30" && kontraScore >= 30) {
      reLost=true;
    }
    else if(reAbsage == "Schwarz" && kontraScore > 0) {
      reLost=true;
    }
    if(reLost) {
      console.log("Re hat Absage " + reAbsage + " nicht erfüllt, Kontra hat " + kontraScore + " Augen.");
    }
  }
  if(kontraAbsage) {
    if(kontraAbsage == "Keine 90" && reScore >= 90) {
      kontraLost=true;
    }
    else if(kontraAbsage == "Keine 60" && reScore >= 60) {
      kontraLost=true;
    }
    else if(kontraAbsage == "Keine 30" && reScore >= 30) {
      kontraLost=true;
    }
    else if(kontraAbsage == "Schwarz" && reScore > 0) {
      kontraLost=true;
    }
    if(kontraLost) {
      console.log("Kontra hat Absage " + kontraAbsage + " nicht erfüllt, Re hat " + reScore + " Augen.");
    }
  }
  if(reLost && !kontraLost) {
    winnerParty = "Kontra";
    winners = round.kontraPlayers;
    gameLog(game.gameId, null, "Kontra gewinnt mit " + kontraScore + " Augen, da Re die Absage " + reAbsage + " nicht erfüllt hat.");
  }
  else if(kontraLost && !reLost) {
    winnerParty = "Re";
    winners = round.rePlayers;
    gameLog(game.gameId, null, "Re gewinnt mit " + reScore + " Augen, da Kontra die Absage " + kontraAbsage + " nicht erfüllt hat.");
  }
  else if(reLost && kontraLost) {
    gameLog(game.gameId, null, "Re und Kontra haben jeweils ihre Absagen " + reAbsage + " bzw. " + kontraAbsage + " nicht erfüllt, keine Partei gewinnt.");
  }
  if(!winnerParty && !(reLost&&kontraLost)) {
    if(reScore > 120) {
      winnerParty = "Re";
      winners = round.rePlayers;
      console.log("Re gewinnt mit " + reScore + " Augen.");
    }
    else if(kontraScore > 120) {
      winnerParty = "Kontra";
      winners = round.kontraPlayers;
      console.log("Kontra gewinnt mit " + kontraScore + " Augen.");
    }
    else { // gespaltener Arsch
      if(!re && kontra) {
        winnerParty = "Re";
        winners = round.rePlayers;
        gameLog(game.gameId, null, "Re gewinnt mit " + reScore + " Augen, weil Kontra jedoch nicht Re angesagt war.");
      }
      else {
        winnerParty = "Kontra";
        winners = round.kontraPlayers;
        console.log("Kontra gewinnt mit " + kontraScore + " Augen.");
      }
    }
  }
  let loserScore = winnerParty == "Kontra"?reScore:kontraScore; // Im Fall beide verloren wird kontra als loserScore berechnet
  let winnerScore = winnerParty == "Kontra"?kontraScore:reScore; // Im Fall beide verloren wird kontra als loserScore berechnet
  if(winnerParty)gameScore.push({desc:"gewonnen",party:winnerParty,value:1});// ein Punkt für gewonnen
  let loserParty = (winnerParty=="Kontra"?"Re":"Kontra");
  if(winnerParty == "Kontra" && ["gesund","hochzeit"].indexOf(round.gameType) > -1) {
    gameScore.push({desc:"gegen die Alten",party:"Kontra",value:1});
  }
  if(winnerParty) {
    if(re) {
      gameScore.push({desc:"Re angesagt",party:winnerParty,value:2});
    }
    if(kontra) {
      gameScore.push({desc:"Kontra angesagt",party:winnerParty,value:2});
    }
  }
  // Absagen anrechnen
  let winnerAnnouncements = winnerParty == "Re"?reAnnouncements:kontraAnnouncements;
  let loserAnnouncements = winnerParty == "Re"?kontraAnnouncements:reAnnouncements;
  if(winnerParty && winnerAnnouncements.indexOf("Keine 90") > -1) { // Punkte für Absagen nur an Gewinner
    gameScore.push({desc:"Keine 90 abgesagt (" + winnerParty + ")",party:winnerParty,value:1});
  }
  if(winnerParty && winnerAnnouncements.indexOf("Keine 60") > -1) {
    gameScore.push({desc:"Keine 60 abgesagt (" + winnerParty + ")",party:winnerParty,value:1});
  }
  if(winnerParty && winnerAnnouncements.indexOf("Keine 30") > -1) {
    gameScore.push({desc:"Keine 30 abgesagt (" + winnerParty + ")",party:winnerParty,value:1});
  }
  if(winnerParty && winnerAnnouncements.indexOf("Schwarz") > -1) {
    gameScore.push({desc:"Schwarz abgesagt (" + winnerParty + ")",party:winnerParty,value:1});
  }
  if(winnerParty && loserAnnouncements.indexOf("Keine 90") > -1) { // 
    gameScore.push({desc:"Keine 90 abgesagt (" + loserParty + ")",party:winnerParty,value:1});
  }
  if(winnerParty && loserAnnouncements.indexOf("Keine 60") > -1) {
    gameScore.push({desc:"Keine 60 abgesagt (" + loserParty + ")",party:winnerParty,value:1});
  }
  if(winnerParty && loserAnnouncements.indexOf("Keine 30") > -1) {
    gameScore.push({desc:"Keine 30 abgesagt (" + loserParty + ")",party:winnerParty,value:1});
  }
  if(winnerParty && loserAnnouncements.indexOf("Schwarz") > -1) {
    gameScore.push({desc:"Schwarz abgesagt (" + loserParty + ")",party:winnerParty,value:1});
  }

  if(loserScore < 90) {
    gameScore.push({desc:"Unter 90 gespielt",party:winnerParty,value:1});
  }
  if(loserScore < 60) {
    gameScore.push({desc:"Unter 60 gespielt",party:winnerParty,value:1});
  }
  if(loserScore < 30) {
    gameScore.push({desc:"Unter 30 gespielt",party:winnerParty,value:1});
  }
  if(loserScore == 0) {
    gameScore.push({desc:"Schwarz gespielt",party:winnerParty,value:1});
  }
  
  // these will even be scored if both parties lost
  if(winnerScore >= 120 && loserAnnouncements.indexOf("Keine 90") > -1) {
    gameScore.push({desc:"120 gegen Keine 90 erreicht",party:winnerParty=="Kontra"?winnerParty:"Re",value:1});
  }
  if(winnerScore >= 90 && loserAnnouncements.indexOf("Keine 60") > -1) {
    gameScore.push({desc:"90 gegen Keine 60 erreicht",party:winnerParty=="Kontra"?winnerParty:"Re",value:1});
  }
  if(winnerScore >= 60 && loserAnnouncements.indexOf("Keine 30") > -1) {
    gameScore.push({desc:"60 gegen Keine 30 erreicht",party:winnerParty=="Kontra"?winnerParty:"Re",value:1});
  }
  if(winnerScore >= 30 && loserAnnouncements.indexOf("Schwarz") > -1) {
    gameScore.push({desc:"30 gegen Schwarz erreicht",party:winnerParty=="Kontra"?winnerParty:"Re",value:1});
  }
  if(loserScore >= 120 && winnerAnnouncements.indexOf("Keine 90") > -1) {
    gameScore.push({desc:"120 gegen Keine 90 erreicht",party:loserParty=="Re"?loserParty:"Kontra",value:1});
  }
  if(loserScore >= 90 && winnerAnnouncements.indexOf("Keine 60") > -1) {
    gameScore.push({desc:"90 gegen Keine 60 erreicht",party:loserParty=="Re"?loserParty:"Kontra",value:1});
  }
  if(loserScore >= 60 && winnerAnnouncements.indexOf("Keine 30") > -1) {
    gameScore.push({desc:"60 gegen Keine 30 erreicht",party:loserParty=="Re"?loserParty:"Kontra",value:1});
  }
  if(loserScore >= 30 && winnerAnnouncements.indexOf("Schwarz") > -1) {
    gameScore.push({desc:"30 gegen Schwarz erreicht",party:loserParty=="Re"?loserParty:"Kontra",value:1});
  }

  let reExtras = [];
  let kontraExtras = [];
  for(let t of round.tricks) {
    if(round.rePlayers.indexOf(t.winnerIdx) > -1) {
      reExtras = reExtras.concat(t.extras);
    }
    else {
      kontraExtras = kontraExtras.concat(t.extras);
    }
  }
  for(let ep of reExtras) {
    gameScore.push({desc:ep,party:"Re",value:1});
  }
  for(let ep of kontraExtras) {
    gameScore.push({desc:ep,party:"Kontra", value:1});
  }
  
  // now add the score to score card and make gameScore available for display
  round.scoreDetails = gameScore;
  let winnerDesc = winnerParty?(winnerParty=="Re"?"Re gewinnt mit " + reScore + " Augen.":"Kontra gewinnt mit " + kontraScore + " Augen."):"Keine Partei gewinnt. Re erreichte " + reScore + " Augen.";
  round.summary = winnerDesc;
  round.winnerParty = winnerParty;
  gameLog(game.gameId, null, winnerDesc);
  if(winners.length == 0) {
    winners = round.rePlayers;
    console.log("Keine Gewinner, wähle Re als 'Gewinner' Spieler zwecks Punktezuweisung");
  }
  let winnerScoreFactor = (winners.length == 1)?3:1;
  let loserScoreFactor = (winners.length == 3)?3:1;
  console.log("winnerScoreFactor=" + winnerScoreFactor + ", loserScoreFactor =" + loserScoreFactor);
  let totalGameScore = gameScore.reduce((ac,v) => {return ac+(v.party==winnerParty?v.value:-v.value);},0);
  round.score[4] = totalGameScore;
  round.score[0] = (winners.indexOf(0) > -1)? winnerScoreFactor*totalGameScore : -loserScoreFactor*totalGameScore;
  round.score[1] = (winners.indexOf(1) > -1)? winnerScoreFactor*totalGameScore : -loserScoreFactor*totalGameScore;
  round.score[2] = (winners.indexOf(2) > -1)? winnerScoreFactor*totalGameScore : -loserScoreFactor*totalGameScore;
  round.score[3] = (winners.indexOf(3) > -1)? winnerScoreFactor*totalGameScore : -loserScoreFactor*totalGameScore;
  round.scoreAccepted = [];
  game.gameStatus = "roundResults";
  game.viewLastTrickIdx = null;
  updateGameState(game.gameId);
  return;  
}

function gameLog(gameId, playerId, msg) {
  let game = gamesList[gameId];
  game.chat.unshift({playerId:playerId,time:new Date(),message:msg});
  console.log("gameLog" + (playerId?"("+playerId+")":"") + ": " + msg);
}

// returns playerIdx
function anyPlayerHasSchweine(game) {
  
  
  for(let i = 0; i< 4;i++) {
    let p = game.playerState[game.players[i]];
    if(p.hand.filter(c=>{return c.id == "schellen-as";}).length == 2) {
      return i;
    }
  }
  return -1;
}

function reportHealth(playerConnection, gameType, gameSubType) {
  let game = gamesList[playerConnection.gameId];
  if(game.gameStatus != "precheck") {
    playerConnection.sendError("cannot accept health report, game not in precheck phase");
    return;
  }
  console.log("" + playerConnection.playerId + " reports health " + gameType + "/" + gameSubType);
  let round = getCurrentRound(game);
  let currentPlayerIdx = game.players.indexOf(playerConnection.playerId);
  console.log("currentPlayerIdx = " + currentPlayerIdx);
  if(currentPlayerIdx < 0) {
    playerConnection.sendError("playerId " + playerConnection.playerId + " not found in game " + gameId);
    return;
  }
  let readyPlayerCount = 0;
  let pidx = round.starterIdx;
  console.log("Startspieler der runde ist " + game.players[pidx]);
  while(readyPlayerCount < 4 && (round.announcements[pidx].length > 0)) {
    console.log("precheck, " + pidx + " hat schon angesagt.");
    readyPlayerCount++;
    pidx++;
    if(pidx>3)pidx=0;
  }
  console.log("next player to report health is " + game.players[pidx]);
  if(pidx != currentPlayerIdx) {
    playerConnection.sendError("Spieler " + playerConnection.playerId + " kann nichts ansagen, da " + game.players[pidx] + " an der Reihe ist.");
    return;
  }
  let announcement = gameType+(gameType=="farbsolo"?"_"+gameSubType:"");
  round.announcements[pidx].push(announcement);
  pidx++;
  if(pidx>3)pidx-=4;
  
  if(round.forcedSoloIdx > -1) {
    console.log("Vorführung von " + game.players[round.starterIdx] + ", Spiel ist " + announcement);
    for(let idx = 0 ; idx < 4; idx++) {
      if(idx != round.starterIdx) {
        round.announcements[idx].push("gesund");
      }
    }
  }
  if(readyPlayerCount == 3 || round.forcedSoloIdx > -1) {
    console.log("all players have announced, determining game");
    let originalStarterIdx = round.starterIdx;
    if(game.currentRound < game.rounds.length-1) {
      game.rounds[game.currentRound+1].starterIdx = originalStarterIdx+1; // next round next player
      if(game.rounds[game.currentRound+1].starterIdx > 3) game.rounds[game.currentRound+1].starterIdx-=4;
    }
    let vorbehaltList = round.announcements.map((pa,idx) => {return pa.filter(e=>{return e != "gesund";}).length>0?idx:null;}).filter(e=>{return e != null;});
    let schweineIdx = anyPlayerHasSchweine(game);
    if(vorbehaltList.length == 0) {
      console.log("alle gesund");
      round.rePlayers = [];
      round.kontraPlayers = [];
      round.gameType = "gesund";
      round.gameSubType = (schweineIdx>-1)?"schweinerei":null;
      gameLog(game.gameId, null, "Normales Spiel");
      if(schweineIdx >-1) {
        round.announcements[schweineIdx].push("Schweine");
        gameLog(game.gameId, game.players[schweineIdx], "Schweinerei!");
      }
    }
    else { // jemand spielt solo
      console.log("" + JSON.stringify(vorbehaltList) + " haben Vorbehalt");
      let awardedPlayerIdx = null;
      let awardedLevel = 0;
      for(let pi = 0; pi < 4; pi++) {
        let vpidx = round.starterIdx+pi;
        if(vpidx > 3) vpidx-=4;
        if(vorbehaltList.indexOf(vpidx) == -1) continue;
        let vorbehalt = round.announcements[vpidx][0];
        let vorbehaltLevel = round.announcements[vpidx][0] == "hochzeit"?1:pflichtsoloGespielt(game, vpidx)?2:3;
        console.log("player " + vpidx + " (" + game.players[vpidx] + ") hat vorbehalt " + vorbehalt + ", level = " + vorbehaltLevel);
        if(awardedPlayerIdx == null) {
          awardedPlayerIdx = vpidx;
          awardedLevel = vorbehalt == "hochzeit"?1:pflichtsoloGespielt(game, vpidx)?2:3;
          console.log("player " + vpidx + " (" + game.players[vpidx] + ") hat bisher höchsten vorbehalt");
        }
        else {
          if(vorbehaltLevel > awardedLevel){
            console.log("player " + vpidx + " (" + game.players[vpidx] + ") hat höheren vorbehalt");
            awardedLevel = vorbehaltLevel;
            awardedPlayerIdx = vpidx;
          }
          else if(vorbehaltLevel == awardedLevel){
            console.log("player " + vpidx + " (" + game.players[vpidx] + ") hat gleichrangigen vorbehalt, sitzt aber hinter " + game.players[awardedPlayerIdx] +".");
          }
        }
      }
      console.log("" + game.players[awardedPlayerIdx] + " spielt " + round.announcements[awardedPlayerIdx][0]);
      round.rePlayers = [awardedPlayerIdx];
      round.kontraPlayers = [];
      if("hochzeit" != round.announcements[awardedPlayerIdx][0]) {
        round.kontraPlayers = [0,1,2,3].filter(e=>{return e!=awardedPlayerIdx;});
        gameLog(game.gameId, null, "" + game.players[awardedPlayerIdx] + " spielt ein Solo");
      }
      else {
        gameLog(game.gameId, null, "" + game.players[awardedPlayerIdx] + " hat eine Hochzeit");
      }
      round.gameType = round.announcements[awardedPlayerIdx][0];
      round.gameSubType = null;
      if(round.gameType == "hochzeit" && schweineIdx >-1){
        round.gameSubType = "schweinerei";
        round.announcements[schweineIdx].push("Schweine");
        gameLog(game.gameId, game.players[schweineIdx], "Schweinerei!");
      }
      if(round.gameType.indexOf("_")>-1) {
        round.gameSubType = round.gameType.substring(round.gameType.indexOf("_")+1,round.gameType.length);
        round.gameType = round.gameType.substring(0, round.gameType.indexOf("_"));
      }
      if(awardedLevel>1) {
        round.starterIdx = awardedPlayerIdx;
        console.log(game.players[awardedPlayerIdx] + " kommt raus, weil er Solo spielt.");
        if(game.currentRound < game.rounds.length-1) {
          game.rounds[game.currentRound+1].starterIdx = originalStarterIdx;
          console.log("" + game.players[originalStarterIdx] + " kommt dann hoffentlich regulär im nächsten Spiel raus...");
        }
      }
    }
    if(!round.tricks)round.tricks =[];
    round.tricks.push({starterIdx:round.starterIdx,cardIds:[],winnerIdx:-1,extras:[]});
    console.log("Starte Spiel...");
    game.gameStatus ="running";
  }
  else {
    console.log("next player to report health is " + game.players[pidx]);
  }
  updateGameState(playerConnection.gameId);
  return;
}

async function revertGame(gameId) {
  let game = gamesList[gameId];
  if(!game) {
    console.error("cannot revert game with id " + gameId + ", not found!");
    return;
  }
  // scan saved games and update state to second recent one, delete the more recent ones ?
  let gameFileNames = await listFiles("gameStates/");
  // group files by gameId
  gameFileNames = gameFileNames.filter(gfn=>{return gfn.startsWith(gameId+"_");}).sort();
  console.log("found games: " + JSON.stringify(gameFileNames));
  let prevState = null;
  for(let i = gameFileNames.length-1; i > -1;i--) {
    let gfn = gameFileNames[i];
    let timeStr = gfn.substring(0,gfn.length-5); // cut .json ending
    timeStr = timeStr.substring(gameId.length+1,timeStr.length); // cut gameId_ on left hand side
    console.log("timeStr = " + timeStr);
    timeStr = timeStr.substring(timeStr.indexOf("_")+1, timeStr.length); // cut instance_ on left hand side
    console.log("timeStr = " + timeStr);
    if(timeStr < game.timestamp) {
      prevState = gfn;
      console.log("found previous state file: " + gfn);
      break;
    }
    else {
      console.log(gfn + " is not before " + game.timestamp + ", looking for earlier files...");
    }
  }
  if(prevState) {
    await loadGame(prevState);
    await updateGameState(gameId);
  }
  else {
    console.log("no state preceding " + game.timestamp + " found!");
  }
}

function removePlayer(playerConnection,removeFromPlayers=true) {
    
    playerConnections.splice(playerConnections.indexOf(playerConnection),1 );
    let game = gamesList[playerConnection.gameId];
    if(game) {
      if(removeFromPlayers) {
        game.players[game.players.indexOf(playerConnection.playerId)]=null;
        console.log("removed player " + playerConnection.playerId + " from game " + playerConnection.gameId);
      }
      else {
        let ps = game.playerState[playerConnection.playerId];
        if(ps) {
          ps.online = false;
        }
      }
    }
    
    playerConnection.socket.terminate();
    updateGameState(playerConnection.gameId);  
}

const interval = setInterval(function ping() {
  for(let pc of playerConnections) {
    if(pc.status == "joining" && (new Date().getTime() - pc.timestamp.getTime()) > 5000) {
       console.log("" + new Date() + ": found stale playeConnection[" +pc.id+"] of " + pc.playerId + " to game " + pc.gameId + ", last updated " + pc.timestamp);
       pc.socket.terminate();
    }
    else {
      if (!pc.isAlive){
        console.log("playerConnection[" + pc.id + "] of " + pc.playerId + " to game " + pc.gameId + " is not alive, terminating.");
        pc.socket.terminate();
        playerConnections.splice(playerConnections.indexOf(pc),1);
        let game = gamesList[pc.gameId];
        let ps = game.playerState[pc.playerId];
        if(ps) {
          ps.online = false;
        }
      }
      else {
        pc.isAlive = false;
        //console.log("pinging socket of " + pc.playerId + " to game " + pc.gameId);
        pc.socket.ping(noop);
      }
    }
  }
}, 5000);

async function updateGameState(gameId) {
  let conns = playerConnections.filter(pc=>{return pc.gameId == gameId;});
  console.log("broadcasting gameState update of game " + gameId + " to " + conns.length + " clients...");
  let game = gamesList[gameId];
  if(!game) {
    console.error("cannot update gameState of game " + gameId + ", not found!");
    return;
  }
  let gameRev = game.rev;
  game.rev = gameRev?gameRev+1:1;
  //game.timestamp = new Date();
  //await writeFile("gameStates/gameState_" + gameId + "_round" + game.currentRound + "_"+(game.rounds[game.currentRound].tricks?"t"+game.rounds[game.currentRound].tricks.length:"pre")+".json", JSON.stringify(game,null,2));
  for(let con of conns) {
    try {
      con.socket.send(JSON.stringify(game));
    }
    catch(e) {
      console.log("failed to send data to " + con.playerId + ": " + e);
    }
  }
}

// `server` is a vanilla Node.js HTTP server, so use
// the same ws upgrade process described here:
// https://www.npmjs.com/package/ws#multiple-servers-sharing-a-single-https-server
const server = app.listen(serverPort);
server.on('upgrade', (request, socket, head) => {
  console.log("websocket request is being upgraded");
  //console.log("method:" + JSON.stringify(request.method));
  //console.log("headers:" + JSON.stringify(request.headers));
  //console.log("url:" + JSON.stringify(request.url));
  let requestURL = url.parse(request.url);
  //console.log("requestURL:" + JSON.stringify(requestURL));
  let path = requestURL.pathname;
  let query = querystring.parse(requestURL.query);
  console.log("path:" + JSON.stringify(path));
  console.log("query:" + JSON.stringify(query));
  let gameFound = false;
  if(path.startsWith("/api/games/") && path.length > 12 && path.endsWith("/join")) {
    let gameId = path.substring(11,path.indexOf('/',11));
    console.log("gameId = " + gameId);
    if(!gamesList[gameId]) {
      console.error("game " + gameId + " not found"); 
    }
    else {
      gameFound = true;
    }
    let playerId = query.playerId;
    console.log("playerId = " + playerId);
    console.log("setting handle upgrade to deal with ws request");
    wsServer.handleUpgrade(request, socket, head, socket => {
      console.log("upgrade negotiated, socket = " + JSON.stringify(request.socket.remoteAddress));
      let pcc = playerConnections.filter(p=>{return p.gameId == gameId;});
      if(pcc.length == 4) {
        console.error("have " + pcc.length + " connections on game " + gameId + ": " + JSON.stringify(
          pcc.map(
            (e)=>{return {id:e.id, playerId:e.playerId, gameId:e.gameId, status:e.status, isAlive:e.isAlive, statusTime:e.statusTime};}
          )
        ));
      }
      // does this player have a connection already?
      let existingPc = playerConnections.find(p=>{return p.playerId == playerId;});
      if(existingPc) {
        console.log("newly connecting player has existing player connection " + [existingPc].map((e)=>{return {id:e.id, playerId:e.playerId, gameId:e.gameId, status:e.status, isAlive:e.isAlive, statusTime:e.statusTime};}));
        if(existingPc.isAlive) {
          // verify connection
          console.log("existing connection isAlive!");
        }
      }
      let playerConnection = {playerId:playerId, id:getPlayerConnectionId(), socket:socket,status:"joining",statusTime:new Date(), isAlive:true, gameId:gameId};
      console.log("created new playerConnection[" + playerConnection.id + "] for player " + playerId + " in game " + gameId);
      playerConnections.push(playerConnection);

      let result = canJoinGame(gameId, playerId);
      if(gameFound && !isNaN(result)) {
        console.log("joining player " + playerId + " at pos " + result);
        let game = gamesList[gameId];  
        game.players[result] = playerId;
        let playerState = game.playerState[playerId];
        if(!playerState) {
          console.log("initializing player state of " + playerId);
          game.playerState[playerId] = {online:false,hand:[],discardPile:[]};
        }
        game.playerState[playerId].online = true;
        if(game.players.filter(p=>{return p!=null;}).length == 4 && game.gameStatus == "init") {
          startGame(gameId);
        }
      }
      else {
        console.log("failed to join player " + playerId + ":" + result);
        if(gamesList[gameId]){
          console.log("players = " + JSON.stringify(gamesList[gameId].players) + ", online status = " + JSON.stringify(Object.values(gamesList[gameId].playerState).map(ps=>{return ""+ps.playerId + ": " + (ps.online?"online":"offline")})));
        }
        playerConnection.error=result;
      }
      wsServer.emit('connection', socket, request);
    });
    return;

  }
  console.log("mismatching request url " + request.url);
  socket.destroy();
});


function getDeck(level) {
  let deck = setupUniqueCards(allCards.filter(c=>{return c.game <= level;}));
  console.log("new deck = " + JSON.stringify(deck.map(c=>{return c.name}),null,2));
  return deck;
}

function startGame(gameId) {
  console.log("starting game " + gameId);
  let game = gamesList[gameId];
  startRound(gameId);
}

function log(gameId, message, gameLog=true){
  let game = gamesList[gameId];
  let d = new Date();
  let timestamp = d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate()+" "+d.getHours()+":"+d.getMinutes()+":"+d.getSeconds();
  let timestampShort = d.getHours()+":"+d.getMinutes()+":"+d.getSeconds();
  let logEntry = {timestamp:d.getTime(), timestr:timestampShort, message:message, activePlayerId:game.activePlayer};
  if(gameLog && game.log && game.log[0]) {
    if(gameLog)game.log[0].entries.unshift(logEntry);
  }
  console.log(timestamp+"-" + gameId+": " +message);
}

async function startRound(gameId) {
  let game = gamesList[gameId];
  // return all cards from turncards and player discard piles to deck
  game.deck = game.deck.concat(game.turnCards.splice(0,game.turnCards.length));
  log(gameId, "Bereite nächstes Spiel vor...", true);
  await updateGameState(gameId);
  
  for(let pid of game.players) {
    let ps = game.playerState[pid];
    game.deck = game.deck.concat(ps.discardPile.splice(0,ps.discardPile.length));
    ps.discardPile = [];
  }
  await updateGameState(gameId);

  if(game.deck.length != 40) {
    console.error("deck hat " + game.deck.length + " karten!");
    process.exit(1);
  }
  
  game.deck = shuffle(game.deck);
  let round = game.rounds[game.currentRound];
  round.rePlayers = [];
  round.kontraPlayers = [];
  log(gameId, game.players[round.starterIdx] + " gibt...", true);
  for(let i = 0; i < 3; i++) {
    for(let pi = 0; pi < 4; pi++) {
      let numCards = (i == 1)?4:3;
      let pidx = (round.starterIdx+pi)%4;
      for(let j = 0; j < numCards;j++) {
        game.playerState[game.players[pidx]].hand.push(game.deck.pop());
      }
      await updateGameState(gameId);
      await sleep(100);
    }
  }
  // check vorführung
  let soloPlayerIdx = -1;
  if(game.rounds.length - game.currentRound <= 4) {
    let noSoloYet = [];
    for(let pidx = 0; pidx < 4;pidx++) {
      if(!pflichtsoloGespielt(game, pidx)) {
        console.log(game.players[pidx] + " hat noch kein Pflichtsolo gespielt.");
        noSoloYet.push(pidx);
      }
    }
    let remainingSoloCount = noSoloYet.length;
    if(remainingSoloCount == game.rounds.length-game.currentRound) {
      // regel 4.2 der nächste spieler ohne solo links vom geber wird zuerst vorgeführt
      soloPlayerIdx = round.starterIdx;
      while(noSoloYet.indexOf(soloPlayerIdx) == -1) {
        soloPlayerIdx++;
        if(soloPlayerIdx > 3)soloPlayerIdx = 0;
      }
      console.log(game.players[soloPlayerIdx] + " wird vorgeführt.");
    }
  }
  if(soloPlayerIdx > -1) {
    round.forcedSoloIdx = soloPlayerIdx;
    if(game.currentRound < game.rounds.length-1) {
      game.rounds[game.currentRound+1].starterIdx = round.starterIdx;
    }
    round.starterIdx = soloPlayerIdx;
  }
  // enter precheck phase
  game.gameStatus = "precheck";
  await saveGame(game);
  await updateGameState(gameId);
}

async function saveGame(game) {
  let startTime = new Date(game.startTime);
  let dateStr = ""+startTime.getYear()+"-"+startTime.getMonth()+"-"+startTime.getDate()+"-"+startTime.getHours()+"-"+startTime.getMinutes();
  if(!game.instance)game.instance = 0;
  game.timestamp = new Date().toISOString().replace(/:/g,"-");
  await writeFile("gameStates/" + game.gameId + "_" + game.instance + "_"+game.timestamp+".json", JSON.stringify(game,null,2));
  console.log("game " + game.gameId + " saved...");
  
}

function canJoinGame(gameId, playerId) {
  let game = gamesList[gameId];
  if(!game) {
    return "game " + gameId + " not found";
  }
  let pind = game.players.indexOf(playerId);
  if(pind > -1) {
    // does this player have an existing player connection?
    let pc = playerConnections.find(e=>{return e.playerId == playerId && e.status != "joining";});
    if(pc) {
      console.log("player " + playerId + " already in game " + gameId + ".");
      return pind;
    }
    else {
      console.log("player " + playerId + " re-joins game " + gameId + " at position " + pind);
      return pind;
    }
  }
  let freeSlotIdx = game.players.indexOf(null);
  if(freeSlotIdx == -1) {
    return "game has no free slots left";
  }
  return freeSlotIdx;
}

/**
gameState stored on server
gameId - unique game identifier as handle
rounds - array of fixed number of round objects, e.g. 16
  round - 
    dealerId, 
    starterId, 
    roundType - normal, hochzeit, solo
    solo - ober, unter, eichel, gruen, herz, schellen, fleischlos    
    roundValue - total value of game
    pflichtsolo - flag indicating mandatory solo
    score - array of int with round scores,
    schweine - flag indicating schweinchen,
    ansagen - array of ansagen per player
    
gameStatus - not started, running, finished
currentRound - index into rounds
players - array of playerIds in sorted order
playerState - map playerId -> playerState
 player - id, hand, discardPile
chat - array of chat posts (senderId, time, text)
**/

app.get('/', (req, res) => {
  res.send('Hello World2!')
})

/**
server api
----------

GET /api/games/list
POST /api/games/<id>/join - initiate websocket link
POST /api/games/<id>/events - add new state modification

Later:
PUT /api/games/<id> - create new game
*/

function createGame(gameId, rounds) {
  if(gameId.indexOf("_") > -1) {
    console.error("cannot create game with underscore in the id: " + gameId);
    return;
  }
  let tg = {
    gameId:gameId,
    rev:0,
    gameStatus:"init",
    currentRound:0,
    turnCards:[],
    deck:getDeck(1),
    players:[null,null,null,null],
    playerState:{},
    chat:[],
    startTime:new Date().getTime()
  };
  tg.rounds = [];
  for(let i = 0; i < rounds; i++) {
    let round = {score:[0,0,0,0], announcements:[[],[],[],[]], rePlayers:[],kontraPlayers:[] };
    tg.rounds.push(round);
  }
  tg.rounds[0].starterIdx = 0;
  saveGame(tg);
  return tg;
}
let gamesList = { };
initGames();

async function listFiles(path) {
  let fileNames = [];
  if(containerClient) {
    let i = 1;
    let blobs = containerClient.listBlobsFlat();
    for await (const blob of blobs) {
      console.log(`Blob ${i++}: ${blob.name}`);
      fileNames.push(blob.name.substring(path.length,blob.name.length));
    }
  }
  else {
    let dirents = fs.readdirSync(path,{withFileTypes:true});
    for(let de of dirents) {
      if(de.isFile()) {
        fileNames.push(de.name);
      }
    }
  }
  return fileNames;
}

async function initGames() {
  let gameFileNames = await listFiles("gameStates/");
  // group files by gameId
  gameFileNames = gameFileNames.sort();
  console.log("found games: " + JSON.stringify(gameFileNames));
  let coveredGameIds = [];
  for(let i = gameFileNames.length-1; i> -1; i--) {
    let gfn = gameFileNames[i];
    console.log("gfn = " + gfn);
    let gameId = gfn.substring(0,gfn.length-5);
    console.log("gameId = " + gameId);
    let suffix = "";
    let instance = 0;
    if(gameId.indexOf("_") > -1) {
      suffix = gameId.substring(gameId.indexOf("_")+1, gameId.length);
      gameId = gameId.substring(0, gameId.indexOf("_"));
      console.log("gameId = " + gameId);
      console.log("suffix = " + suffix);
      if(suffix.indexOf("_")>-1) {
        let instanceStr = suffix.substring(0,suffix.indexOf("_"));
        console.log("instanceStr=" + instanceStr);
        instance = parseInt(instanceStr);
        suffix = suffix.substring(instanceStr.length+1,suffix.length);
        console.log("suffix = " + suffix);
      }
      console.log("suffix = " + suffix);
      console.log("instance = " + instance);
    }
    if(coveredGameIds.indexOf(gameId) > -1) {
      console.log("game " + gameId + " already loaded, skipping " + gfn);
      continue;
    }
    await loadGame(gfn);
    coveredGameIds.push(gameId);
  }
  console.log("all loading done");
}

// [Node.js only] A helper method used to read a Node.js readable stream into a Buffer
async function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on("data", (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    readableStream.on("error", reject);
  });
}
  
async function readFile(path) {
  let data = null;
  if(containerClient) {
    let blobClient = containerClient.getBlobClient(path);
    const downloadBlockBlobResponse = await blobClient.download();
    data = (
      await streamToBuffer(downloadBlockBlobResponse.readableStreamBody)
    ).toString();
    //console.log("Downloaded blob content:", data);
 
  }
  else {
    data = fs.readFileSync(path);
  }
  return data;
}

async function writeFile(path, content) {
  if(containerClient) {
    let blockBlobClient = containerClient.getBlockBlobClient(path);
    let uploadBlobResponse = await blockBlobClient.upload(content, content.length);
    console.log("Upload block blob ${blobName} successful", uploadBlobResponse.requestId);  
  }
  else {
    fs.writeFileSync(path, content);
  }
}

async function loadGame(gameFileName) {
  let gd = null;
  try { 
    gd = await readFile("gameStates/" + gameFileName);
  }
  catch(e) {
    console.log(e);
  }
  if(gd) {
    gd = JSON.parse(gd);
    gamesList[gd.gameId] = gd;
    console.log("read " + gd.gameId + " state from file " + gameFileName + ", timestamp= " + gd.timestamp);
    for(let ps of Object.values(gd.playerState)) {
      ps.online = false;
    }
    if(!gd.instance && gd.instance != 0) {
      console.log("injecting instance into read game...");
      gd.instance = 0;
    }
    if(gd.gameStatus == "running") {
      let round = gd.rounds[gd.currentRound];
      if(gd.turnCards.length == 4) {
        console.log("loaded game in running state with 4 played turnCards, resolving trick");
        resolveTrick(gd);
      }
      if(round.tricks.length == 10 && round.tricks[9].cardIds.length == 4) {
        console.log("loaded game in running state with all tricks played, resolving round");
        await resolveRound(gd);
      }      
    }
    else if(gd.gameStatus == "roundResults" && gd.rounds[gd.currentRound].scoreAccepted && gd.rounds[gd.currentRound].scoreAccepted.filter(e=>{return e==true;}).length == 4) {
      if(gd.currentRound == gd.rounds.length-1) {
        console.log("loaded game with completed result acceptance check of last round, resolving game");
        await resolveGame(gd);
      }
      else {
        console.log("loaded game with completed result acceptance check, starting next round");
        gd.currentRound++;
        await startRound(gd.gameId);
      }
    }
  }
}

let headers = (req, res, next) => {
  //console.log("checking request: " + req.url);
  res.header('Access-Control-Allow-Origin', '*');
  let token = req.query.token;
  if(!Object.values(playerCreds).find(c=>{return c.token == token;})) {
    console.log("request without correct api token: " + req.url + ", apiToken: " + token);
    res.status(404).send('not found');
    return;
  }
  next();
}

app.put('/api/games/:gameId', headers, (req, res) => {
  //res.header('Access-Control-Allow-Origin', '*');
  let gameId = req.params.gameId;
  let tableDesc = req.body;
  console.log("game desc: " + JSON.stringify(tableDesc));
  let rounds = tableDesc.rounds;
  if(!rounds)rounds = 16;
  console.log("PUT /api/games/" + gameId);
  if(Object.keys(gamesList).indexOf(gameId) > -1) {
    res.status(409).send('game already exists!');
    console.log("Cannot create game " + gameId + ": already exists!");
    return;
  }
  let newGame = createGame(gameId, rounds);
  gamesList[gameId] = newGame;
  res.status(201).send({meta:{message:"entity created"}, content:newGame});
})

app.get('/api/games', headers, (req, res) => {
  res.status(200).send({meta:{message:"listing games"}, content:Object.values(gamesList).map(g=>{return {id:g.gameId, players:g.players, 
  rounds:g.rounds.length, completedRounds:g.rounds.filter(r=>{return r.summary != null;}).length, extras:[]};})});
});

app.get('/api/games/:gameId/join', headers, (req, res) => {
  let gameId = req.params.gameId;
  let playerId = req.params.playerId;
  console.log("got request from player " + playerId + " to join game " + gameId);
});

app.post('/api/games/:gameId/revert', headers, (req, res) => {
  let gameId = req.params.gameId;
  console.log("got request to revert game " + gameId);
  revertGame(gameId);
  /*
  let game = gamesList[gameId];
  if(!game) {
    res.status(404).send({meta:{message:"Game not found"},content:{}});
    return;
  }
  let round = game.rounds[game.currentRound];
  console.log("game " + gameId + " is currently in round " + game.currentRound);
  let completedTricks = round.tricks.filter(t=>{return t.winnerIdx>-1;});
  if(completedTricks > 0) {
    console.log("game " + gameId + " last completed trick is " + (completedTricks-1));
    
  }
  else {
    
  }
  */
});

app.post('/api/login', (req, res) => {
  //console.log("login, header = " + JSON.stringify(req.headers));
  //console.log("login, body = " + req.body);
  console.log("login JSON: " + JSON.stringify(req.body));
  let creds = playerCreds[req.body.playerId];
  console.log("creds = " + creds);
  if(creds && (!creds.failedAttempts || creds.failedAttempts < 5) 
    && creds.pass == req.body.pass) {
    res.send({meta:{message:"success"},content:{apiToken:playerCreds[req.body.playerId].token}});
    console.log("successful authN by " + req.body.playerId + ", sending token.");
    return;
  }
  else {
    res.status(409).send({meta:{message:"Invalid username / password"},content:{}});
    if(playerCreds[req.body.playerId]) {
      if(!playerCreds[req.body.playerId].failedAttempts){
        playerCreds[req.body.playerId].failedAttempts = 1;
      }
      else {
        playerCreds[req.body.playerId].failedAttempts+=1;
      }
    }
    console.log("Failed login " + req.body.playerId + (playerCreds[req.body.playerId]?", attempts = " + playerCreds[req.body.playerId].failedAttempts:""));
  }
  return;
});
