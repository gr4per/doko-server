function capitalize(s) {
  return s.charAt(0).toUpperCase()+s.substring(1,s.length);
}

function cardFromId(cardId) {
  let type = cardId.substring(0, cardId.indexOf("-"));
  let subtype = cardId.substring(cardId.indexOf("-")+1, cardId.length);
  return {id:cardId, type:type,subtype:subtype};
}

function isCardLegal(game, playerId, cardId) {
  let round = game.rounds[game.currentRound];
  let trick = round.tricks[round.tricks.length-1];
  let cardsInTrick = game.turnCards.length;
  let activePlayerIdx = trick.starterIdx;
  let currentPlayerIdx = game.players.indexOf(playerId);
  for(let i = 0; i < cardsInTrick; i++) {
    activePlayerIdx++;
    if(activePlayerIdx>3)activePlayerIdx-=4;
  }
  console.log("" + cardsInTrick + " cards already played, first card by " + trick.starterIdx + " next card expected from player " + activePlayerIdx);
  if(activePlayerIdx != currentPlayerIdx) {
    return "Spieler " + playerId + " ist nicht an der Reihe.";
  }
  // now check whether card is legal
  let player = game.playerState[playerId];
  let card = player.hand.find(c=>{return c.id == cardId;});
  if(!card) {
    return "Spieler " + playerId + " hat Karte " + prettyPrint(game, cardId) + " nicht auf der Hand.";
  }
  console.log("card is " + card.id);
  if(cardsInTrick > 0) {
    let firstCard = game.turnCards[0];
    if(isTrumpf(firstCard, round.gameType, round.gameSubType)) {
      console.log("Spieler " + playerId + " muss Trumpf bedienen.");
      if(!isTrumpf(card, round.gameType, round.gameSubType)) {
        let hasTrumpf = false;
        for(let rc of player.hand) {
          if(isTrumpf(rc, round.gameType, round.gameSubType)) {
            hasTrumpf = true;
            break;
          }
        }
        if(hasTrumpf) {
          return "Spieler " + playerId + " muss Trumpf bedienen.";
        }
      }
    }
    else {
      let farbe = firstCard.type;
      console.log("Spieler " + playerId + " muss " + capitalize(farbe) + " bedienen.");
      if(card.type != farbe || isTrumpf(card, round.gameType, round.gameSubType)) {
        let hasFarbe = false;
        for(let rc of player.hand) {
          if(!isTrumpf(rc, round.gameType, round.gameSubType) && rc.type == farbe) {
            hasFarbe = true;
            break;
          }
        }
        if(hasFarbe) {
          return "Spieler " + playerConnection.playerId + " muss " + capitalize(farbe) + " bedienen.";
        }
      }
    }
  }
}

function pflichtsoloGespielt(game, vpidx) {
  for(let ridx = 0; ridx < game.currentRound; ridx++) {
    if(["obersolo","untersolo","farbsolo_eichel","farbsolo_schellen","farbsolo_gruen","farbsolo_herz","fleischloser","koenigsolo"].indexOf(game.rounds[ridx].announcements[vpidx][0]) > -1) {
      return true;
    }
  }
  return false;
}

function isTrumpf(card, gameType, gamesubtype) {
  if(typeof card == "string") {
    card = {type:card.substring(0,card.indexOf("-")), subtype:card.substring(card.indexOf("-")+1, card.length)};
  }
  //console.log("isTrumpf(" + card.id + ", " + gameType + ", " + gamesubtype);
  if(card.type=="herz" && card.subtype == "zehn") {
    if(["gesund","hochzeit","farbsolo"].indexOf(gameType) > -1) {
      return true;
    }
    else return false;
  }
  
  if(card.subtype=="ober") {
    //console.log("card is ober");
    if(["gesund","hochzeit","farbsolo","obersolo"].indexOf(gameType) > -1) {
      return true; 
    }
    else {
      return false;
    }
  }
  if(card.subtype=="unter") {
    let ind = ["gesund","hochzeit","farbsolo","untersolo"].indexOf(gameType);
    //console.log("card is unter, ind = " + ind);
    if(ind > -1) {
      return true; 
    }
    else {
      return false;
    }
  }
  else if(gameType=="farbsolo" && card.type==gamesubtype) {
    //console.log("card is matching farbsolo");
    return true; 
  }
  else if(gameType=="koenigsolo" && card.subtype=="koenig") {
    //console.log("card is matching farbsolo");
    return true; 
  }
  if(card.type=="schellen") {
    //console.log("card is schellen");
    if(["gesund","hochzeit"].indexOf(gameType) > -1) {
      //console.log("schellen trumpf in " + gameType);
      return true; 
    }
    else {
      return false;
    }
  }
}

function compareFehl(card0, card1, gameType, gamesubtype) {
  if(card0.type == card1.type) {
    //console.log("both cards are " + card0.type);
    return ["as","zehn","koenig","ober","unter","neun"].indexOf(card0.subtype) - ["as","zehn","koenig","ober","unter","neun"].indexOf(card1.subtype);
  }
  //console.log("cards are different type of fehl: card0 " + card0.subtype + ", card1 " + card1.subtype);
  let ind0 = ["eichel","gruen","herz","schellen"].indexOf(card0.type);
  let ind1 = ["eichel","gruen","herz","schellen"].indexOf(card1.type);
  //console.log("ind0 " + ind0 + ", ind1 " + ind1);
  return  ind0-ind1;
}

// does card0 trump card1 ? returns -1 if card0 is higher than card1 (sort trump left in hand)
function compareTrumpf(card0,card1,gameType, gamesubtype) {
  if(gamesubtype == "schweinerei") {
    //console.log("schweinerei");
    if(card0.type=="schellen" && card0.subtype=="as" ) {
      return (card1.type=="schellen" && card1.subtype=="as")?0:-1; // schweine sind die höchsten trümpfe
    }
    else if(card1.type=="schellen" && card1.subtype=="as" ) {
      return 1; // schweine sind die höchsten trümpfe
    }
  }
  
  if(card0.type=="herz" && card0.subtype=="zehn") {
    //console.log("card0 is dulle");
    return (card1.type=="herz" && card1.subtype=="zehn")?0:-1; // herz zehn höher als verbleibende Trümpfe
  }
  if(card1.type=="herz" && card1.subtype=="zehn") {
    //console.log("card1 is dulle, card0 not");
    return 1; // herz zehn höher als verbleibende Trümpfe
  }
  
  if(card0.subtype == "ober") {
    console.log("card0 is ober: " + JSON.stringify(card0));
    if(card1.subtype == "ober") {
      console.log("card1 is ober, too: " + JSON.stringify(card1));
      let res = ["eichel","gruen","herz","schellen"].indexOf(card0.type) - ["eichel","gruen","herz","schellen"].indexOf(card1.type);
      console.log("res = " + res);
      return res;
    }
    return -1;
  }
  if(card1.subtype == "ober") {
    //console.log("card1 is ober but card0 not, card1 higher");
    return 1;
  }
  if(card0.subtype == "unter") {
    //console.log("card0 is unter");
    if(card1.subtype == "unter") {
      //console.log("card1 is unter, too");
      return ["eichel","gruen","herz","schellen"].indexOf(card0.type) - ["eichel","gruen","herz","schellen"].indexOf(card1.type);
    }
    return -1;
  }
  if(card1.subtype == "unter") {
    //console.log("card1 is unter but card0 not, card1 higher");
    return 1;
  }
  if(gameType=="koenigsolo") {
    if(card0.subtype == "koenig") {
      //console.log("card0 is koenig");
      if(card1.subtype == "koenig") {
        //console.log("card1 is koenig, too");
        return ["eichel","gruen","herz","schellen"].indexOf(card0.type) - ["eichel","gruen","herz","schellen"].indexOf(card1.type);
      }
      return -1;
    }
    if(card1.subtype == "koenig") {
      //console.log("card1 is koenig but card0 not, card1 higher");
      return 1;
    }
  }
  // normale Trümpfe, d.h. As, 10, König, neun
  return compareFehl(card0,card1,gameType,gamesubtype);
}

// this prints the card name as relevant to current game situation
function prettyPrint(game, card) {
  if(typeof card == "string") {
    card = cardFromId(card);
  }
  let gameType = game.rounds[game.currentRound].gameType;
  if(card.id == "schellen-as") {
    if(isSchweinerei(game)) {
      return "ein Schwein";
    }
    else if(["gesund","hochzeit"].indexOf(gameType) > -1) {
      return "einen Fuchs";
    }
    else return "ein Schellen As";
  }
  else if(card.id == "herz-zehn") {
    if(["gesund", "hochzeit", "farbsolo"].indexOf(gameType) > -1) {
      return "eine Dulle";
    }
    return "eine Herz Zehn";
  }
  else if(card.id == "eichel-unter") {
    if(["gesund", "hochzeit"].indexOf(gameType) > -1) {
      return "ein Karlchen";
    }
    return "einen Eichel Unter";
  }
  else if(card.id == "eichel-ober") {
    if(["gesund", "hochzeit"].indexOf(gameType) > -1) {
      return "einen Alten";
    }
    else return "einen Eichel Ober";
  }
  else if(["koenig","ober","unter"].indexOf(card.subtype) > -1) {
    return "einen " + capitalize(card.type) + " " + capitalize(card.subtype);
  }
  else if(["zehn", "neun"].indexOf(card.subtype) > -1) {
    return "eine " + capitalize(card.type) + " " + capitalize(card.subtype);
  }
  else return "ein " + capitalize(card.type) + " " + capitalize(card.subtype);
}

function isSchweinerei(game) {
  return game.rounds[game.currentRound].gameSubType=="schweinerei";
}

function setupUniqueCards(arr) {
  let res = [];
  let count = 0;
  for(let sc of arr) {
    let multiplicity = 1;
    if(sc.multiplicity)multiplicity=sc.multiplicity;
    for(let i = 0; i < multiplicity;i++) {
      let cardInstance = JSON.parse(JSON.stringify(sc));
      count++;
      cardInstance.uniqueId = cardInstance.type + ":" + cardInstance.id + (multiplicity>1?":"+i:"");
      res.push(cardInstance); // deep copy
    }
  }
  //console.log("expanded: " + JSON.stringify(res, null,2));
  return res;
}

function shuffle(arr) {
  let res = [];
  while(arr.length >0) {
    let pick = Math.floor(Math.random()*arr.length);
    res.push(arr.splice(pick,1)[0]);
    //console.log("pick = " + pick + ", res size = " + res.length + ", arr size = " + arr.length);
  }
  //console.log("shuffled: " + JSON.stringify(res, null,2));
  return res;
}

function getPlayerParty(game, playerIdx) {
  let playerId = game.players[playerIdx];
  let player = game.playerState[playerId];
  let round = game.rounds[game.currentRound];
  let playerParty = round.rePlayers.indexOf(playerIdx) > -1?"Re":round.kontraPlayers.indexOf(playerIdx) > -1?"Kontra":null;
  if(playerParty) {
    console.log("Spieler " + playerId + " ist " + playerParty);
  }
  else {
    console.log("Spieler " + playerId + " hat sich noch nicht gezeigt.");
  }
  if(!playerParty && round.gameType == "gesund") { // schliesst stille hochzeit ein
    if(player.hand.find(c=>{return c.id == "eichel-ober";})) {
      playerParty = "Re";
    }
    else {
      playerParty = "Kontra";
    }
    console.log("Normalspiel, Spieler ist " + playerParty + ", da " + (playerParty=="Re"?"":"k")+ "ein Eichel-Ober auf der Hand ist.");
  }
  return playerParty;
}

function getPossibleNextAnnouncement(game, playerIdx) {
  //console.log("checking announcements available to player [" + playerIdx + "] in game " + game.gameId);
  let playerId = game.players[playerIdx];
  let player = game.playerState[playerId];
  let round = game.rounds[game.currentRound];
  let announcementOffset = 0;
  let playerParty = getPlayerParty(game, playerIdx);
  if(round.gameType == "hochzeit") {// kann nur noch Hochzeit sein
    //console.log("Hochzeit!");
    let klaerungsstichIdx = getKlaerungsstich(round);
    //console.log("klaerungsstichIdx = " + klaerungsstichIdx);
    if(klaerungsstichIdx == -1) {
      // ungeklärte hochzeit, keine Ansagen möglich
      console.log("ungeklärt");
      return null;
    }
    // in allen anderen Fällen ist die Parteizugehörigkeit des Spielers schon im Klärungsstich notiert worden
    announcementOffset = klaerungsstichIdx;
  }
  //console.log("announcementOffset = " + announcementOffset);
  let previousAnnouncements = round.announcements.map( (ans, idx) => {return (ans.length>1)?(((round.rePlayers.indexOf(idx)>-1&&playerParty=="Re")||(round.kontraPlayers.indexOf(idx)>-1&&playerParty=="Kontra")||(idx==playerIdx))?ans[ans.length-1]:null):null;}).filter(e=>{return e!= null;});
  let opponentPartyAnnouncements = round.announcements.map( (ans, idx) => {return (ans.length>1)?(((round.rePlayers.indexOf(idx)>-1&&playerParty=="Kontra")||(round.kontraPlayers.indexOf(idx)>-1&&playerParty=="Re"))?ans[ans.length-1]:null):null;}).filter(e=>{return e!= null;});
  let opponentInitialAnnouncement = opponentPartyAnnouncements.indexOf("Re") > -1 || opponentPartyAnnouncements.indexOf("Kontra") > -1 || opponentPartyAnnouncements.indexOf("Keine 90") > -1 || opponentPartyAnnouncements.indexOf("Keine 60") > -1 || opponentPartyAnnouncements.indexOf("Keine 30") > -1 || opponentPartyAnnouncements.indexOf("Schwarz") > -1;
  if(previousAnnouncements.indexOf("Keine 30") > -1) previousAnnouncements.unshift("Keine 60");
  if(previousAnnouncements.indexOf("Keine 60") > -1) previousAnnouncements.unshift("Keine 90");
  if(previousAnnouncements.indexOf("Keine 90") > -1) previousAnnouncements.unshift(playerParty);
  console.log("previous announcements:" + JSON.stringify(previousAnnouncements));
  let limit = 9-announcementOffset;
  let possibleNextAnnouncement = (playerParty=="Re")?"Re":"Kontra";
  if(previousAnnouncements.indexOf(possibleNextAnnouncement) > -1){
    possibleNextAnnouncement = "Keine 90";
    limit--;
  }
  if(previousAnnouncements.indexOf(possibleNextAnnouncement) > -1) {
    possibleNextAnnouncement = "Keine 60";
    limit--;
  }
  if(previousAnnouncements.indexOf(possibleNextAnnouncement) > -1) {
    possibleNextAnnouncement = "Keine 30";
    limit--;
  }
  if(previousAnnouncements.indexOf(possibleNextAnnouncement) > -1) {
    possibleNextAnnouncement = "Schwarz";
    limit--;
  }
  
  let currentCards = player.hand.length;
  if(opponentInitialAnnouncement && (possibleNextAnnouncement == "Re" || possibleNextAnnouncement == "Kontra")) {
    limit--;
    //console.log("Erstansage, gegnerische Partei hat bereits angesagt, also Kartenlimit um eins verringert.");
  }
  if(currentCards >= limit) {
    return possibleNextAnnouncement;
  }
  return null;
}

function getKlaerungsstich(round) {
  if(round.gameType != "hochzeit") return 0;
  let hochzeiterIdx = round.announcements.map(e=>{return e[0];}).indexOf("hochzeit"); // wer hat "hochzeit" als erste Ansage gemacht? kann nur einer sein
  let mitspielerIdx = -1;
  for(let i = 0; i < round.tricks.length; i++) {
    let trick = round.tricks[i];
    if(trick.winnerIdx > -1 && trick.winnerIdx != hochzeiterIdx) {
      mitspielerIdx = trick.winnerIdx;
      return i;
    }
  }
  if(mitspielerIdx == -1 && round.tricks.length < 4) {
    // dritter Stich noch nicht durch, d.h. noch ungeklärt
    return -1;
  }
  return 2; // nach 4.4.3 doppelkopfregel ist der dritte Stich hier der Klärungsstich
}


exports.setupUniqueCards = setupUniqueCards;
exports.isCardLegal = isCardLegal;
exports.pflichtsoloGespielt = pflichtsoloGespielt;
exports.isTrumpf = isTrumpf;
exports.prettyPrint = prettyPrint;
exports.isSchweinerei = isSchweinerei;
exports.compareFehl = compareFehl;
exports.compareTrumpf = compareTrumpf;
exports.capitalize = capitalize;
exports.shuffle = shuffle;
exports.getPossibleNextAnnouncement = getPossibleNextAnnouncement;
exports.getKlaerungsstich = getKlaerungsstich;
exports.getPlayerParty = getPlayerParty;
