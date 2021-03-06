var fs = require('fs');
var gm = require('gm').subClass({imageMagick: true});
var db = require('../DB/DB.js');
var path = require('path');
var session = require('express-session');
var cookieParser = require('cookie-parser');
var Parse = require('node-parse-api').Parse;
var parseConfig = require('./config');

var APP_ID = parseConfig.app_id;
var MASTER_KEY = parseConfig.master_key;
var parseApp = new Parse(APP_ID, MASTER_KEY);


module.exports = {
  dbLock: {},
  errorLogger: function (error, req, res, next) {
    // log the error then send it to the next middleware in
    // middleware.js

    console.error(error.stack);
    next(error);
  },
  errorHandler: function (error, req, res, next) {
    // send error message to client
    // message for gracefull error handling on app
    res.send(500, {error: error.message});
  },

  hasSession: function (req, code) {
    console.log('Inside hasSession, req.cookie is: ', req.cookies);
    //return req.session ? !!req.session.user : false;
    if(!!req.session.user === false){
      return false;
    } else if(req.cookies[code + '_playerID']) {
      return true;
    } else {
      return false;
    }
  },

  decodeBase64Image: function(dataString) {
    var matches = dataString.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/),
      response = {};

    if (matches.length !== 3) {
      return new Error('Invalid input string');
    }
    response.type = matches[1];
    console.log("response.type is", response.type);
    response.data = new Buffer(matches[2], 'base64');

    return response;
  },

  makeImages: function(gameCode, numPlayers, callback) {
    console.log("---------");
    console.log("makeImages was invoked... making images");
    console.log("---------");

    var finalImageURL = 'client/uploads/' + gameCode + '.png';
    var readStream = fs.createReadStream("Server/assets/drawings/" + gameCode + "0.png");
    var myArgs = [];
    var gmObj = gm(readStream).append("Server/assets/drawings/" + gameCode + "1.png");
    for(var i = 2; i < numPlayers; i ++){
      gmObj = gmObj.append("Server/assets/drawings/" + gameCode + i + ".png");
    }
    // using http://aheckmann.github.io/gm/docs.html#append
    gmObj.write(finalImageURL, function (err) {
      console.log("Streaming the image now");
      if (err) {
        console.log("There was an error creating the exquisite corpse:", err);
      } else {
        console.log("The exquisite corpse was combined successfuly!");
        module.exports.uploadImageToParse(gameCode, finalImageURL, function(finalImageURL) {
          db.game.findOneAndUpdate({ game_code: gameCode }, {final_image_url: finalImageURL, drawing_finished: true}, function(err, game) {
            if (err) {
              console.log("There was an error updating the drawing_finished property on the game in the DB.");
            } else {
              console.log("Great! The drawing_finished property was successfully updated. The image on Parse is at", finalImageURL);
            }
          });
        });
      }

    });
  },

  checkFinalImage: function(code, finalImageReadyCallback, gameInProgressCallback) {

    // **NB** this finalImageURL is hard coded right now, but later it should be path_to_images/gameID.png
    var finalImageURL = 'client/uploads/' + code + '.png';
    // first, check to see if the final image exists.
    fs.stat(finalImageURL, function(err, res) {
      if (err) {
        gameInProgressCallback(err);
        console.log("The image", finalImageURL, "doesn't exist!");
      } else {
        // if the image exists, then send the path to the image onward.
        var fixedFinalImageURL = finalImageURL.slice(6);
        console.log("The final image URL was successfully retrieved from the server. It's", fixedFinalImageURL);
        finalImageReadyCallback({imageURL: fixedFinalImageURL});
      }
    });
  },

  //Create a new player for a specific game.
  createPlayer: function(req, res, game, code, callback) {

    var userName = game.player_count;
    console.log("When we create the player, the code is", code);
    console.log("the dbLock: ", module.exports.dbLock[code]);
    if(module.exports.dbLock[code]){
      setTimeout(function(){
        console.log("A player is waiting to enter the game.").
        createPlayer(req, res, game, code, callback);
      }, 50);
    } else{
      console.log("Locking the game while the player is created");
      module.exports.dbLock[code] = true;
      console.log(module.exports.dbLock[code]);
      // add this player to the database.
      db.player.findOneAndUpdate({user_name: userName, game_code: code}, {user_name: userName, counted: false, game_code: code, started_drawing: true}, {upsert: true, 'new': true}, function (err, player) {
        // console.log("New player", userName, "Has been added to game:", code);
        // console.log("We are making cookies!");
        res.cookie(code + '_playerName', player.user_name, { maxAge: 900000, httpOnly: false});
        res.cookie(code + '_playerID', player._id,{ maxAge: 900000, httpOnly: false});
        res.cookie(code, true, { maxAge: 900000, httpOnly: false});
        req.session.user = player._id;
        // console.log("The cookies are:", res.cookie);
        // once the player has been added, we'll update the game table with the new player's info
        // this update also includes count++
        // console.log("We're creating the player. the Player is:", player);
        var gameObj = {};
        gameObj.$inc = {'player_count':1};
        gameObj[userName] = player.id;
        console.log("Console logging gameObj", gameObj);
        db.game.findOneAndUpdate({game_code: code}, gameObj, function(err, game){
          if(err){
            console.log(err);
          } else {
            // console.log("GET GAME: This is the game data", game);
            // send game back to client.
            res.cookie('templateId', game.template,{ maxAge: 900000, httpOnly: false});
            res.send({game: game, player: player});
            if(callback){
              callback(player);
            }
          }

        });
      });
      this.dbLock[code] = false;
    }
  },

  getPlayerSession: function(req, res, code) {
    // check if the user has submitted their drawing.
    console.log("-----------------------");
    console.log("getting the player session...");
    console.log("-----------------------");
    console.log(req.cookies);
    var username = req.cookies[code + '_playerID'];
    console.log('username is', username);
    db.player.findOne({game_code: code, _id: username}, function(err, player) {
      console.log("inside db.player.findOne in getPlayerSession");
      if (err) console.log("There was an error finding the user by their ID", err)
      // if the user has submitted their drawing
      if (player) {
        if (player.submitted_drawing) {
          // show them a please wait screen (perhaps with a reload button so they can see the final image)
          console.log("The player has submitted a drawing. Let's not let them make a new drawing");
          var codeAndDrawingStatus = code + '_' + 'submitted_drawing';
          var responseObj = {};
          responseObj[codeAndDrawingStatus] = true;
          res.send(responseObj);
        } else if (!player.submitted_drawing && player.started_drawing) {
          console.log("The player has started drawing, but hasn't submitted yet.");
          var codeAndDrawingStatus = code + '_' + 'submitted_drawing';
          var responseObj = {};
          responseObj[codeAndDrawingStatus] = false;
          res.send(responseObj);
        }
        console.log(player);
      }
    });
  },

  createUniqueGameCode: function(){

    var text = "";
    var possible = "abcdefghijklmnopqrstuvwxyz0123456789";

    for( var i=0; i < 4; i++ )
        text += possible.charAt(Math.floor(Math.random() * possible.length));

    return text;

  },

  createNewGame: function(playerCount, res){
    var code = this.createUniqueGameCode();
    var templateNumber;
    // var players;
    if (playerCount === "4") {
      templateNumber = Math.floor(Math.random() * 4);
      // players = {0: null, 1: null, 2: null, 3: null};
    } else if (playerCount === "2") {
      templateNumber = 4;
      // players = {0: null, 1: null};
    }
    var game = new db.game({game_code: code, num_players: playerCount, player_count: 0, submission_count: 0, game_started: true, drawing_finished: false, 0: null, 1: null, 2: null, 3: null, template: templateNumber}).save();
    console.log("the unique code is:" + code);
    module.exports.dbLock[code] = false;
    res.send(code);
  },

  //update a game if it already exists
  updateGame: function(player, gameCode, res, callback) {
    //create a new game object
    var gameObj = {};
    console.log('player.id is ', player._id);
    // console.log('player.id is ', player.id);
    gameObj[player.user_name] = player._id;
    // console.log('gameObj[player.user_name] is ', gameObj[player.user_name]);
    //if the player has never submitted a drawing...
    if(!player.counted){
      //increment number of submitted drawings
      gameObj.$inc = {'submission_count':1};
      //update the player to know they have been counted
      db.player.findOneAndUpdate({user_name: player.user_name, game_code: gameCode}, {counted: true}, {upsert: true, 'new': true}, function (err, player) {
        console.log("Player count updated.");
      });
      //update the game with the new player information
      db.game.findOneAndUpdate({game_code: gameCode}, gameObj, {upsert: true, 'new': true}, function (err, game){
        //if all players have submitted drawings
        console.log('Game count VS number of players', game.submission_count, game.num_players);
        console.log("The gameObj", gameObj);
        if (game.submission_count === game.num_players) {
          console.log("Let's invoke the image stitcher function now");
          // invoke create unified image function
          module.exports.makeImages(gameCode, game.num_players, function() {
            if (err) throw err;
            console.log("Done drawing the image, check the image folder!");
            if(callback){
              callback();
            }
          });
        }
      });
    }
    console.log("I'm sending the status now!");
    return res.sendStatus(201);

  },

  resolveFinishedGame: function (game) {
    if (game.drawing_finished) {
      // if the drawing is completed
      this.checkFinalImage(game.game_code, function() {
        var imageURL = '/client/uploads' + game.game_code + '.png';
        // we need to send it back.
        res.send({imageURL: imageURL});
      });
    } else {
      res.sendStatus(500);
      // if the drawing got messed up or never got completed
        // we will try to draw it again.
    }
  },

  uploadImageToParse: function(gameCode, imageURL, callback) {
    module.exports.createBufferFromImage(imageURL, function(buffered) {
      parseApp.insertFile(gameCode + '.png', buffered, 'image/png', function (err, response) {
        if (err) {
          console.log("There was an error uploading to Parse", err);
        }
        console.log("The image was uploaded to Parse and is at:", response.url);
        callback(response.url);
      });

    })

  },

  createBufferFromImage: function(image, callback) {
    fs.readFile(image, function(err, readData) {
      if (err) {
        console.log("There was an error reading the image and creating a buffer", err); 
      } else {
        var buffered = new Buffer(readData);
        callback(buffered);
      }
    })
  }
}