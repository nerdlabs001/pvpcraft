/**
 * Created by macdja38 on 2016-04-25.
 */
"use strict";

const Player = require('../lib/Player.js');
const MusicDB = require("../lib/MusicDB");
const SlowSender = require("../lib/SlowSender");

let key = require('../config/auth.json').youtubeApiKey || null;
if (key == "key") {
  key = null;
}

let videoUtils = require("../lib/videoUtils");

/**
 *
 * @type {music}
 * @param {Player} boundChannels
 */
class music {
  /**
   * Instantiates the module
   * @constructor
   * @param {Object} e
   * @param {Client} e.client Eris client
   * @param {Config} e.config File based config
   * @param {Raven?} e.raven Raven error logging system
   * @param {Config} e.auth File based config for keys and tokens and authorisation data
   * @param {ConfigDB} e.configDB database based config system, specifically for per guild settings
   * @param {R} e.r Rethinkdb r
   * @param {Permissions} e.perms Permissions Object
   * @param {Feeds} e.feeds Feeds Object
   * @param {MessageSender} e.messageSender Instantiated message sender
   * @param {SlowSender} e.slowSender Instantiated slow sender
   * @param {PvPClient} e.pvpClient PvPCraft client library instance
   */
  constructor(e) {
    this.client = e.client;
    this.fileConfig = e.config;
    this.config = e.configDB;
    this.raven = e.raven;
    this._slowSender = new SlowSender(e);
    this.r = e.r;
    this.musicDB = new MusicDB(this.r, {key});
    this.conn = e.conn;
    this.leaveChecker = false;
    this.boundChannels = [];
  }

  static getCommands() {
    return ["init", "play", "skip", "list", "time", "pause", "resume", "volume", "shuffle", "next", "destroy", "logchannel", "link"];
  }

  onReady() {
    this._slowSender.onReady();
    if (!this.leaveChecker) {
      this.leaveChecker = setInterval(this.leaveUnused.bind(this), 60000);
    }
  }

  init(id, msg, command, perms) {
    let returnPromise = new Promise((resolve, reject) => {
      let voiceChannel = msg.channel.guild.channels.get(msg.member.voiceState.channelID);
      if (!perms.checkUserChannel(msg.author, voiceChannel, "music.initinto")) {
        command.replyAutoDeny("Sorry but you need the permission `music.initinto` in this voice channel to summon the bot here." +
          " Please try another voice channel or contact a mod/admin if you believe this is in error.");
        return true;
      }
      this.boundChannels[id] = new Player({
        client: this.client,
        voiceChannel,
        textChannel: msg.channel,
        apiKey: key,
        raven: this.raven,
        musicDB: this.musicDB,
        slowSender: this._slowSender,
        r: this.r,
        conn: this.conn,
        config: this.config
      });
      command.replyAutoDeny("Binding to **" + voiceChannel.name + "** and **" + msg.channel.name + "**");
      return this.boundChannels[id].init(msg).then(() => {
        command.replyAutoDeny(`Bound successfully use ${command.prefix}destroy to unbind it.`);
        resolve(this.boundChannels[id]);
      }).catch(error => {
        command.replyAutoDeny(error.toString()).catch(console.error);
        reject(error);
        delete this.boundChannels[id];
      });
    });
    returnPromise.catch(() => {
    });
    return returnPromise;
  }

  leaveUnused() {
    Object.keys(this.boundChannels).forEach((id) => {
      let channel = this.boundChannels[id];
      if (channel.connection
        && channel.ready
        && channel.connection.playing !== true
        && (Date.now() - channel.lastPlay > 600000)
        && channel.voice.voiceMembers.size < 2) {
        channel.text.createMessage("Leaving voice channel due to inactivity.")
          .catch((error) => {
            // does not matter if it fails to send the message, we leave anyway
          })
          .then(() => {
            try {
              channel.destroy();
            } catch (error) {

            }
            delete this.boundChannels[id];
          })
      }
    });
  }


  onDisconnect() {
    this._slowSender.onDisconnect();
    if (this.leaveChecker) {
      clearInterval(this.leaveChecker);
    }
    for (let i in this.boundChannels) {
      if (this.boundChannels.hasOwnProperty(i))
        this.boundChannels[i].text.createMessage("Sorry for the inconvenience bot the bot is restarting or disconnected from discord.");
      try {
        this.boundChannels[i].destroy();
      } catch (err) {

      }
      delete this.boundChannels[i];
    }
  }

  /**
   * Called with a command, returns true or a promise if it is handling the command, returns false if it should be passed on.
   * @param {Message} msg
   * @param {Command} command
   * @param {Permissions} perms
   * @returns {boolean | Promise}
   */
  onCommand(msg, command, perms) {
    if (!msg.channel.guild) return false; //this is a pm... we can't do music stuff here.
    let id = msg.channel.guild.id;

    if (command.command === "init" && perms.check(msg, "music.init")) {
      if (this.boundChannels.hasOwnProperty(id)) {
        command.replyAutoDeny(`Sorry already in use in this server. Use ${command.prefix}destroy to erase that connection.`);
        return true;
      }
      if (msg.member.voiceState.channelID) {
        this.init(id, msg, command, perms);
      }
      else {
        command.createMessageAutoDeny(msg.member.mention + ", You must be in a voice channel this command. If you are currently in a voice channel please rejoin it.")
      }
      return true;
    }

    if (command.command === "destroy" && perms.check(msg, "music.destroy")) {
      if (this.boundChannels.hasOwnProperty(id)) {
        try {
          this.boundChannels[id].destroy();
        } catch (error) {

        }
        command.replyAutoDeny("Disconnecting from voice chat and unbinding from text chat.");
        delete this.boundChannels[id];
      } else {
        command.replyAutoDeny("Not bound.");
      }
      return true;
    }

    if (command.command === "play" && perms.check(msg, "music.play")) {
      if (!msg.member.voiceState.channelID) {
        command.replyAutoDeny("You must be in the current voice channel to queue a song. If you are already in the voice channel please leave and rejoin or toggle your mute.");
        return true;
      }
      if (command.args.length < 1) {
        command.replyAutoDeny("Please specify a youtube video search term or playlist!");
        return true;
      }
      if (!this.boundChannels.hasOwnProperty(id)) {
        if (perms.check(msg, "music.init")) {
          this.init(id, msg, command, perms).then(() => {
            let queueCount = perms.check(msg, "music.songcount", {type: "number"});
            if (typeof(queueCount === "number")) {
              this.boundChannels[id].enqueue(command.args.join(" "), msg.member, command, queueCount);
            } else {
              this.boundChannels[id].enqueue(command.args.join(" "), msg.member, command);
            }
          }).catch(() => {
          });
        } else {
          command.replyAutoDeny(`Please have someone with the permission node \`music.init\` run ${command.prefix}init`)
        }
      } else {
        if (!this.boundChannels[id].ready) {
          command.replyAutoDeny("Connection is not ready");
          return true;
        }
        let queueCount = perms.check(msg, "music.songcount", {type: "number"});
        if (typeof(queueCount === "number")) {
          this.boundChannels[id].enqueue(command.args.join(" "), msg.member, command, queueCount)
        } else {
          this.boundChannels[id].enqueue(command.args.join(" "), msg.member, command)
        }
      }
      return true;
    }


    if ((command.command === "next" || command.command === "skip") && (perms.check(msg, "music.voteskip") || perms.check(msg, "music.forceskip"))) {
      if (this.possiblySendNotConnected(msg, command)) return true;
      if (this.possiblySendUserNotInVoice(msg, command)) return true;
      return this.musicDB.queueLength(id).then(async (length) => {
        let index = command.args[0] ? parseInt(command.args[0]) - 1 : -1;
        if (index >= length) {
          command.replyAutoDeny("Not enough songs to skip, queue a song using //play <youtube url of video or playlist>");
          return true;
        }
        let isForced = (command.flags.includes('f') && perms.check(msg, "music.forceskip"));
        if (isForced) {
          command.replyAutoDeny(`Removing ${videoUtils.prettyPrint(await this.skipSongGetInfo(id, index))} From the queue`);
        } else {
          return this.musicDB.addVote(id, index, msg.author.id).then(async (result) => {
            if (typeof result === "number") {
              let maxVotes = Math.floor((this.boundChannels[id].voice.voiceMembers.size / 3)) + 1;
              if (result >= maxVotes) {
                command.replyAutoDeny(`Removing ${videoUtils.prettyPrint(await this.skipSongGetInfo(id, index))} From the queue`);
              } else {
                let info = await this.musicDB.getNextVideosCachedInfoAndVideo(id, 1, index);
                command.replyAutoDeny(`${result}/${maxVotes} votes needed to skip ${videoUtils.prettyPrint(info[0].info)}`)
              }
            } else {
              command.replyAutoDeny("Sorry, you may only vote to skip once per song.");
            }
          });
        }
      });
    }


    if (command.command === "pause" && perms.check(msg, "music.pause")) {
      if (this.boundChannels.hasOwnProperty(id) && this.boundChannels[id].hasOwnProperty("connection")) {
        if (this.boundChannels[id].connection.playing && !this.boundChannels[id].connection.paused) {
          this.boundChannels[id].pause();
          command.replyAutoDeny(`Paused Playback use ${command.prefix}resume to resume it.`)
        } else {
          command.replyAutoDeny(`Cannot pause unless something is being played`)
        }
      } else {
        command.createMessageAutoDeny("Sorry, Bot is not currently in a voice channel use " + command.prefix + "init while in a voice channel to bind it.")
      }
      return true;
    }


    if (command.command === "resume" && perms.check(msg, "music.resume")) {
      if (this.boundChannels.hasOwnProperty(id) && this.boundChannels[id].hasOwnProperty("connection")) {
        if (this.boundChannels[id].connection.paused) {
          this.boundChannels[id].resume(msg);
          command.replyAutoDeny("Playback resumed.")
        } else {
          command.replyAutoDeny(`Cannot resume unless something is paused.`)
        }
      } else {
        command.createMessageAutoDeny("Sorry, Bot is not currently in a voice channel use " + command.prefix + "init while in a voice channel to bind it.")
      }
      return true;
    }


    if (command.commandnos === "list" && perms.check(msg, "music.list")) {
      if (this.boundChannels.hasOwnProperty(id)) {
        return this.boundChannels[id].prettyList().then((list) => {
          command.createMessageAutoDeny("```xl\n" + list
            + "```\n" + this.fileConfig.get("website", {musicUrl: "https://bot.pvpcraft.ca/login/"}).musicUrl.replace(/\$id/, msg.channel.guild.id));
        })
      } else {
        command.createMessageAutoDeny("Sorry, Bot is not currently in a voice channel use " + command.prefix + "init while in a voice channel to bind it.")
      }
      return true;
    }


    if (command.commandnos === "time" && perms.check(msg, "music.time")) {
      if (this.boundChannels.hasOwnProperty(id) && this.boundChannels[id].hasOwnProperty("connection")) {
        if (this.boundChannels[id].currentVideoInfo) {
          command.createMessageAutoDeny("Currently " +
            videoUtils.prettyTime(this.boundChannels[id].currentVideoInfo) +
            " into " +
            videoUtils.prettyPrint(this.boundChannels[id].currentVideoInfo));
        } else {
          command.createMessageAutoDeny("Sorry, no song's found in playlist. use " + command.prefix + "play <youtube vid or playlist> to add one.")
        }
      } else {
        command.createMessageAutoDeny("Sorry, Bot is not currently in a voice channel use " + command.prefix + "init while in a voice channel to bind it.")
      }
      return true;
    }

    if (command.commandnos === "link" && perms.check(msg, "music.link")) {
      if (this.boundChannels.hasOwnProperty(id) && this.boundChannels[id].hasOwnProperty("connection")) {
        if (this.boundChannels[id].currentVideoInfo) {
          command.createMessageAutoDeny(`The link to ${videoUtils.prettyPrint(this.boundChannels[id].currentVideoInfo)} is ${this.boundChannels[id].currentVideo.link}`);
        } else {
          command.createMessageAutoDeny("Sorry, no song's found in playlist. use " + command.prefix + "play <youtube vid or playlist> to add one.")
        }
      } else {
        command.createMessageAutoDeny("Sorry, Bot is not currently in a voice channel use " + command.prefix + "init while in a voice channel to bind it.")
      }
      return true;
    }

    if (command.commandnos === "volume" && (perms.check(msg, "music.volume.set") || perms.check(msg, "music.volume.list"))) {
      command.replyAutoDeny("In order to vastly increase performance volume is currently disabled, This feature may be re-enabled in the future");
      return true;
      if (this.boundChannels.hasOwnProperty(id) && this.boundChannels[id].hasOwnProperty("connection")) {
        if (command.args[0] && perms.check(msg, "music.volume.set")) {
          let volume = parseInt(command.args[0]);
          if (111 > volume && volume > 4) {
            this.boundChannels[id].setVolume(volume);
            command.replyAutoDeny(`Volume set to **${volume}**`).catch(perms.getAutoDeny(msg));

          } else {
            command.replyAutoDeny("Sorry, invalid volume, please enter a number between 5 and 110").catch(perms.getAutoDeny(msg));
          }
          return true;
        } else {
          if (perms.check(msg, "music.volume.list")) {
            command.replyAutoDeny("Current volume is **" + this.boundChannels[id].getVolume() + "**").catch(perms.getAutoDeny(msg));
            return true;
          }
          return false;
        }
      } else {
        if (perms.check(msg, "music.volume.list") || perms.check(msg, "music.volume.set")) {
          command.createMessageAutoDeny(`Sorry, Bot is not currently in a voice channel use ${command.prefix} init while in a voice channel to bind it.`);
          return true;
        }
        else {
          return false;
        }
      }
    }


    if (command.command === "shuffle" && perms.check(msg, "music.shuffle")) {
      if (this.possiblySendNotConnected(msg, command)) return true;
      if (this.boundChannels[id]) {
        command.createMessageAutoDeny(this.boundChannels[id].shuffle());
      } else {
        command.createMessageAutoDeny("Sorry, not enough song's in playlist.")
      }
      return true;
    }


    if (command.commandnos === "logchannel" && perms.check(msg, "music.logchannels")) {
      let text = "Playing Music in:\n";
      for (let i in this.boundChannels) {
        if (this.boundChannels.hasOwnProperty(i)) {
          text += `Server: ${this.boundChannels[i].server.name} in voice channel ${this.boundChannels[i].text.name}\n`
        }
      }
      if (text != "Playing Music in:\n") {
        command.createMessageAutoDeny(text);
      }
      else {
        command.createMessageAutoDeny("Bot is currently not in use");
      }
      return true;
    }

    return false;
  }

  /**
   * Skips a song based on guild id and song index
   * @param {string} id
   * @param {number} index
   * @returns {Promise<Object>} video
   */
  skipSong(id, index) {
    if (index < 0) {
      if(this.boundChannels.hasOwnProperty(id)) {
        let player = this.boundChannels[id];
        if (player.hasOwnProperty("currentVideo")) {
          player.skipSong();
          return Promise.resolve(player.currentVideo);
        } else {
          return this.musicDB.spliceVideo(id, index+1);
        }
      }
    }
    return this.musicDB.spliceVideo(id, index);
  }

  /**
   * Skips a song and returns its info
   * @param {string} id
   * @param {number} index
   */
  skipSongGetInfo(id, index) {
    return this.skipSong(id, index).then(song => {
      return this.musicDB.getCachingInfoLink(song.link, {allowOutdated: true})
    });
  }

  /**
   *
   * @param {Message} msg
   * @param {Command} command
   * @returns {boolean}
   */
  possiblySendNotConnected(msg, command) {
    let id = msg.channel.guild.id;
    if (this.boundChannels.hasOwnProperty(id) && this.boundChannels[id].hasOwnProperty("connection")) {
      return false;
    }
    command.createMessageAutoDeny("Sorry, Bot is not currently in a voice channel use " + command.prefix + "init while in a voice channel to bind it.");
    return true;
  }

  /**
   *
   * @param {Message} msg
   * @param {Command} command
   * @returns {boolean}
   */
  possiblySendUserNotInVoice(msg, command) {
    if (msg.member.voiceState.channelID) {
      let player = this.boundChannels[msg.channel.guild.id];
      if (!player || !player.connection || msg.member.voiceState.channelID === player.connection.channelID) {
        return false;
      } else {
        command.createMessageAutoDeny("Sorry but you must be in the same voice channel as the bot to use this command.");
        return true
      }
    }
    command.createMessageAutoDeny("Sorry but you must be in a voice channel to use this command.");
    return true;
  }
}

module.exports = music;