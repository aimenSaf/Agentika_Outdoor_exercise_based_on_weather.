// This is the Edge Chat Demo Worker, built using Durable Objects!

// ===============================
// Introduction to Modules
// ===============================
//
// The first thing you might notice, if you are familiar with the Workers platform, is that this
// Worker is written differently from others you may have seen. It even has a different file
// extension. The `mjs` extension means this JavaScript is an ES Module, which, among other things,
// means it has imports and exports. Unlike other Workers, this code doesn't use
// `addEventListener("fetch", handler)` to register its main HTTP handler; instead, it _exports_
// a handler, as we'll see below.
//
// This is a new way of writing Workers that we expect to introduce more broadly in the future. We
// like this syntax because it is *composable*: You can take two workers written this way and
// merge them into one worker, by importing the two Workers' exported handlers yourself, and then
// exporting a new handler that call into the other Workers as appropriate.
//
// This new syntax is required when using Durable Objects, because your Durable Objects are
// implemented by classes, and those classes need to be exported. The new syntax can be used for
// writing regular Workers (without Durable Objects) too, but for now, you must be in the Durable
// Objects beta to be able to use the new syntax, while we work out the quirks.
//
// To see an example configuration for uploading module-based Workers, check out the wrangler.toml
// file or one of our Durable Object templates for Wrangler:
//   * https://github.com/cloudflare/durable-objects-template
//   * https://github.com/cloudflare/durable-objects-rollup-esm
//   * https://github.com/cloudflare/durable-objects-webpack-commonjs

// ===============================
// Required Environment
// ===============================
//
// This worker, when deployed, must be configured with two environment bindings:
// * rooms: A Durable Object namespace binding mapped to the ChatRoom class.
// * limiters: A Durable Object namespace binding mapped to the RateLimiter class.
//
// Incidentally, in pre-modules Workers syntax, "bindings" (like KV bindings, secrets, etc.)
// appeared in your script as global variables, but in the new modules syntax, this is no longer
// the case. Instead, bindings are now delivered in an "environment object" when an event handler
// (or Durable Object class constructor) is called. Look for the variable `env` below.
//
// We made this change, again, for composability: The global scope is global, but if you want to
// call into existing code that has different environment requirements, then you need to be able
// to pass the environment as a parameter instead.
//
// Once again, see the wrangler.toml file to understand how the environment is configured.

// =======================================================================================
// The regular Worker part...
//
// This section of the code implements a normal Worker that receives HTTP requests from external
// clients. This part is stateless.

// With the introduction of modules, we're experimenting with allowing text/data blobs to be
// uploaded and exposed as synthetic modules. In wrangler.toml we specify a rule that files ending
// in .html should be uploaded as "Data", equivalent to content-type `application/octet-stream`.
// So when we import it as `HTML` here, we get the HTML content as an `ArrayBuffer`. This lets us
// serve our app's static asset without relying on any separate storage. (However, the space
// available for assets served this way is very limited; larger sites should continue to use Workers
// KV to serve assets.)
import HTML from "./chat.html";
import { getAssetFromKV, mapRequestToAsset } from '@cloudflare/kv-asset-handler'
import manifestJSON from '__STATIC_CONTENT_MANIFEST'
const assetManifest = JSON.parse(manifestJSON);
// import {zbencode, zbdecode} from "../public/encoding.mjs";
import {DataClient, NetworkedDataClient/*, DCMap, DCArray*/} from "../public/data-client.mjs";
import {NetworkedIrcClient} from "../public/irc-client.mjs";
import {NetworkedCrdtClient} from "../public/crdt-client.mjs";
import {NetworkedLockClient} from "../public/lock-client.mjs";
import {handlesMethod as networkedAudioClientHandlesMethod} from "../public/audio/networked-audio-client-utils.mjs";
import {handlesMethod as networkedVideoClientHandlesMethod} from "../public/video/networked-video-client-utils.mjs";
import {parseUpdateObject, serializeMessage} from "../public/util.mjs";
import {UPDATE_METHODS} from "../public/update-types.mjs";

// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production
// code but it is convenient when debugging and iterating.
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
      // won't show us the response body! So... let's send a WebSocket response with an error
      // frame instead.
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

// In modules-syntax workers, we use `export default` to export our script's main event handlers.
// Here, we export one handler, `fetch`, for receiving HTTP requests. In pre-modules workers, the
// fetch handler was registered using `addEventHandler("fetch", event => { ... })`; this is just
// new syntax for essentially the same thing.
//
// `fetch` isn't the only handler. If your worker runs on a Cron schedule, it will receive calls
// to a handler named `scheduled`, which should be exported here in a similar way. We will be
// adding other handlers for other types of events over time.
export default {
  async fetch(request, env, ctx) {
    return await handleErrors(request, async () => {
      // We have received an HTTP request! Parse the URL and route the request.

      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        // Serve our HTML at the root path.
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

      switch (path[0]) {
        case "api":
          // This is a request for `/api/...`, call the API handler.
          return handleApiRequest(path.slice(1), request, env);
        case 'public':
          return handlePublicRequest(path.slice(1), request, env, ctx);
        default:
          return new Response("Not found", {status: 404});
      }
    });
  }
}

async function handlePublicRequest(path, request, env, ctx) {
  try {
    const event = {
      request,
      waitUntil(promise) {
        return ctx.waitUntil(promise)
      },
    }
    const options = {};
    function handlePrefix(prefix) {
      return request => {
        // compute the default (e.g. / -> index.html)
        let defaultAssetKey = mapRequestToAsset(request)
        let url = new URL(defaultAssetKey.url)

        // strip the prefix from the path for lookup
        url.pathname = url.pathname.replace(prefix, '/')

        // inherit all other props from the default request
        return new Request(url.toString(), defaultAssetKey)
      }
    }
    options.mapRequestToAsset = handlePrefix(/^\/public/);
    options.ASSET_NAMESPACE = env.__STATIC_CONTENT;
    options.ASSET_MANIFEST = assetManifest;
    const page = await getAssetFromKV(event, options)

    // allow headers to be altered
    const response = new Response(page.body, page);

    // console.log('got response', response);

    return response;
  } catch(err) {
    console.log('error', err);
    return new Response(err.stack, {
      status: 500,
    })
  }
}

async function handleApiRequest(path, request, env) {
  // We've received at API request. Route the request based on the path.

  switch (path[0]) {
    case "room": {
      // Request for `/api/room/...`.

      if (!path[1]) {
        // The request is for just "/api/room", with no ID.
        if (request.method == "POST") {
          // POST to /api/room creates a private room.
          //
          // Incidentally, this code doesn't actually store anything. It just generates a valid
          // unique ID for this namespace. Each durable object namespace has its own ID space, but
          // IDs from one namespace are not valid for any other.
          //
          // The IDs returned by `newUniqueId()` are unguessable, so are a valid way to implement
          // "anyone with the link can access" sharing. Additionally, IDs generated this way have
          // a performance benefit over IDs generated from names: When a unique ID is generated,
          // the system knows it is unique without having to communicate with the rest of the
          // world -- i.e., there is no way that someone in the UK and someone in New Zealand
          // could coincidentally create the same ID at the same time, because unique IDs are,
          // well, unique!
          let id = env.rooms.newUniqueId();
          return new Response(id.toString(), {headers: {"Access-Control-Allow-Origin": "*"}});
        } else {
          // If we wanted to support returning a list of public rooms, this might be a place to do
          // it. The list of room names might be a good thing to store in KV, though a singleton
          // Durable Object is also a possibility as long as the Cache API is used to cache reads.
          // (A caching layer would be needed because a single Durable Object is single-threaded,
          // so the amount of traffic it can handle is limited. Also, caching would improve latency
          // for users who don't happen to be located close to the singleton.)
          //
          // For this demo, though, we're not implementing a public room list, mainly because
          // inevitably some trolls would probably register a bunch of offensive room names. Sigh.
          return new Response("Method not allowed", {status: 405});
        }
      }

      // OK, the request is for `/api/room/<name>/...`. It's time to route to the Durable Object
      // for the specific room.
      let name = path[1];

      // Each Durable Object has a 256-bit unique ID. IDs can be derived from string names, or
      // chosen randomly by the system.
      let id;
      /* if (name.match(/^[0-9a-f]{64}$/)) {
        // The name is 64 hex digits, so let's assume it actually just encodes an ID. We use this
        // for private rooms. `idFromString()` simply parses the text as a hex encoding of the raw
        // ID (and verifies that this is a valid ID for this namespace).
        id = env.rooms.idFromString(name);
      } else */if (name.length <= 128) {
        // Treat as a string room name (limited to 32 characters). `idFromName()` consistently
        // derives an ID from a string.
        id = env.rooms.idFromName(name);
      } else {
        return new Response("Name too long", {status: 404});
      }

      // Get the Durable Object stub for this room! The stub is a client object that can be used
      // to send messages to the remote Durable Object instance. The stub is returned immediately;
      // there is no need to await it. This is important because you would not want to wait for
      // a network round trip before you could start sending requests. Since Durable Objects are
      // created on-demand when the ID is first used, there's nothing to wait for anyway; we know
      // an object will be available somewhere to receive our requests.
      let roomObject = env.rooms.get(id);

      // Compute a new URL with `/api/room/<name>` removed. We'll forward the rest of the path
      // to the Durable Object.
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + name + "/" + path.slice(2).join("/");

      // Send the request to the object. The `fetch()` method of a Durable Object stub has the
      // same signature as the global `fetch()` function, but the request is always sent to the
      // object, regardless of the request's URL.
      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", {status: 404});
  }
}

//

const readCrdtFromStorage = async (storage, arrayNames) => {
  const crdt = new Map();
  for (const arrayId of arrayNames) {
    const array = await storage.get(arrayId) ?? {};
    crdt.set(arrayId, array);

    for (const arrayIndexId in array) {
      const val = await storage.get(arrayIndexId) ?? [
        0,
        {},
      ];
      crdt.set(arrayIndexId, val);
    }
  }
  return crdt;
};
const dataClientPromises = new Map();
const crdtClientPromises = new Map();
const lockClientPromises = new Map();

//

const schemaArrayNames = [
  'worldApps',
];

const _pauseWebSocket = (ws) => {
  const queue = [];
  const onmessage = e => {
    queue.push(e.data);
  };
  ws.addEventListener('message', onmessage);
  return () => {
    for (const data of queue) {
      ws.dispatchEvent(new MessageEvent('message', {data}));
    }
    queue.length = 0;

    ws.removeEventListener('message', onmessage);
  };
};

// =======================================================================================
// The ChatRoom Durable Object Class

// ChatRoom implements a Durable Object that coordinates an individual chat room. Participants
// connect to the room using WebSockets, and the room broadcasts messages from each participant
// to all others.
export class ChatRoom {
  constructor(controller, env) {
    // `controller.storage` provides access to our durable storage. It provides a simple KV
    // get()/put() interface.
    this.storage = controller.storage;

    // `env` is our environment bindings (discussed earlier).
    this.env = env;

    // We will put the WebSocket objects for each client, along with some metadata, into
    // `sessions`.
    this.sessions = [];

    // We keep track of the last-seen message's timestamp just so that we can assign monotonically
    // increasing timestamps even if multiple messages arrive simultaneously (see below). There's
    // no need to store this to disk since we assume if the object is destroyed and recreated, much
    // more than a millisecond will have gone by.
    this.lastTimestamp = 0;
  }

  // The system will call fetch() whenever an HTTP request is sent to this Object. Such requests
  // can only be sent from other Worker code, such as the code above; these requests don't come
  // directly from the internet. In the future, we will support other formats than HTTP for these
  // communications, but we started with HTTP for its familiarity.
  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      const match = url.pathname.match(/^\/([^\/]+?)\/([^\/]+?)$/);
      const roomName = match ? match[1] : '';
      const methodName = match ? match[2] : '';

      switch (methodName) {
        case "websocket": {
          // The request is to `/api/room/<name>/websocket`. A client is trying to establish a new
          // WebSocket session.
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }

          // Get the client's IP address for use with the rate limiter.
          let ip = request.headers.get("CF-Connecting-IP");

          // To accept the WebSocket request, we create a WebSocketPair (which is like a socketpair,
          // i.e. two WebSockets that talk to each other), we return one end of the pair in the
          // response, and we operate on the other end. Note that this API is not part of the
          // Fetch API standard; unfortunately, the Fetch API / Service Workers specs do not define
          // any way to act as a WebSocket server today.
          let pair = new WebSocketPair();

          // We're going to take pair[1] as our end, and return pair[0] to the client.
          await this.handleSession(pair[1], ip, roomName, url);

          // Now we return the other end of the pair to the client.
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        case 'get': {
          break;
        }

        case 'set': {
          break;
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  // handleSession() implements our WebSocket-based chat protocol.
  async handleSession(webSocket, ip, roomName, url) {
    // Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
    // WebSocket in JavaScript, not sending it elsewhere.
    webSocket.accept();

    const playerId = url.searchParams.get('playerId') ?? null;
    /* if (!playerId) {
      console.log('closing due to no playerId');
      webSocket.close();
      return;
    } */

    const realm = {
      key: roomName,
    };

    let dataClientPromise = dataClientPromises.get(roomName);
    if (!dataClientPromise) {
      dataClientPromise = (async () => {
        const crdt = await readCrdtFromStorage(this.storage, schemaArrayNames);
        const dataClient = new DataClient({
          crdt,
          userData: {
            realm,
          },
        });
        return dataClient;
      })();
      dataClientPromises.set(roomName, dataClientPromise);
    }
    let crdtClientPromise = crdtClientPromises.get(roomName);
    if (!crdtClientPromise) {
      crdtClientPromise = (async () => {
        let initialUpdate = await this.storage.get('crdt');
        console.log('get room crdt', initialUpdate);
        const crdtClient = new NetworkedCrdtClient({
          initialUpdate,
        });
        crdtClient.addEventListener('update', async e => {
          const uint8array = crdtClient.getStateAsUpdate();
          // console.log('put room crdt', uint8array);
          await this.storage.put('crdt', uint8array);
        });
        return crdtClient;
      })();
      crdtClientPromises.set(roomName, crdtClientPromise);
    }
    let lockClientPromise = lockClientPromises.get(roomName);
    if (!lockClientPromise) {
      lockClientPromise = (async () => {
        const lockClient = new NetworkedLockClient();
        return lockClient;
      })();
      lockClientPromises.set(roomName, lockClientPromise);
    }

    const _resumeWebsocket = _pauseWebSocket(webSocket);

    const dataClient = await dataClientPromise;
    const crdtClient = await crdtClientPromise;
    const lockClient = await lockClientPromise;
    const networkClient = {
      /* serializeMessage(message) {
        if (message.type === 'networkinit') {
          const {playerIds} = message.data;
          return zbencode({
            method: UPDATE_METHODS.NETWORK_INIT,
            args: [
              playerIds,
            ],
          });
        } else {
          throw new Error('invalid message type: ' + message.type);
        }
      }, */
      getNetworkInitMessage: () => {
        return new MessageEvent('networkinit', {
          data: {
            playerIds: this.sessions
              .map((session) => session.playerId)
              .filter((playerId) => playerId !== null),
          },
        });
      },
    };

    let session = {webSocket, playerId/*, blockedMessages: []*/};
    this.sessions.push(session);

    // send import
    webSocket.send(serializeMessage(dataClient.getImportMessage()));
    // send initial update
    webSocket.send(serializeMessage(crdtClient.getInitialUpdateMessage()));
    // send network init
    webSocket.send(serializeMessage(networkClient.getNetworkInitMessage()));

    // set up dead hands tracking
    const deadHands = new Map();
    // let triggered = false;
    const _triggerDeadHands = () => {
      // console.log('trigger dead hands');
      // if (triggered) {
      //   throw new Error('double trigger');
      // } else {
      //   triggered = true;
      // }
      // const entries = Array.from(deadHands.entries());
      for (const [key, {arrayId, arrayIndexId}] of deadHands.entries()) {
        const array = dataClient.getArray(arrayId, {
          listen: false,
        });
        if (arrayIndexId !== null) { // map mode
          // console.log('dead hand map', arrayId, arrayIndexId);
          // const map = dataClient.getArrayMap(arrayId, arrayIndexId, {
          //   listen: false,
          // });
          if (array.hasKey(arrayIndexId)) {
            const map = array.getMap(arrayIndexId, {
              listen: false,
            });
            const removeMapUpdate = map.removeUpdate();
            const removeMapUpdateBuffer = serializeMessage(removeMapUpdate);
            proxyMessageToPeers(removeMapUpdateBuffer);

            /* const array = dataClient.getArray(arrayId, {
              listen: false,
            });
            for (const arrayIndexId of array.getKeys()) {
              const map = array.getMap(arrayIndexId, {
                listen: false,
              });
              const removeMessage = map.removeUpdate();
              const removeArrayUpdateBuffer = serializeMessage(removeMessage);
              proxyMessageToPeers(removeArrayUpdateBuffer);
            } */
          }
        } else { // array mode
          // console.log('dead hand array', arrayId);

          for (const arrayIndexId of array.getKeys()) {
            const map = array.getMap(arrayIndexId, {
              listen: false,
            });
            const removeMessage = map.removeUpdate();
            const removeArrayUpdateBuffer = serializeMessage(removeMessage);
            proxyMessageToPeers(removeArrayUpdateBuffer);
          }
        }
        // console.log('iter end');
      }
    };
    const _triggerUnlocks = () => {
      lockClient.serverUnlockSession(session);
    };

    dataClient.addEventListener('deadhand', e => {
      const {keys, deadHand} = e.data;
      if (deadHand === playerId) {
        // const key = `${arrayId}:${arrayIndexId}`;
        for (const key of keys) {
          let match;
          if (match = key.match(/^([^\.]+?)\.([^\.]+)$/)) {
            const arrayId = match[1];
            const arrayIndexId = match[2];
            deadHands.set(key, {
              arrayId,
              arrayIndexId,
            });
          } else if (match = key.match(/^([^\.]+)$/)) {
            const arrayId = match[1];
            deadHands.set(key, {
              arrayId,
              arrayIndexId: null,
            });
          } else {
            throw new Error('invalid deadhand key: ' + key);
          }
        }
        // console.log('register dead hand', e.data, {arrayId, arrayIndexId, deadHand});
      }
    });
    dataClient.addEventListener('livehand', e => {
      const {keys, liveHand} = e.data;
      if (liveHand === playerId) {
        for (const key of keys) {
          deadHands.delete(key);
        }
        // console.log('register live hand', e.data, {arrayId, arrayIndexId, liveHand});
      }
    });

    // Set up our rate limiter client.
    // let limiterId = this.env.limiters.idFromName(ip);
    // let limiter = new RateLimiterClient(
    //     () => this.env.limiters.get(limiterId),
    //     err => webSocket.close(1011, err.stack));

    // Create our session and add it to the sessions list.
    // We don't send any messages to the client until it has sent us the initial user info
    // message. Until then, we will queue messages in `session.blockedMessages`.

    // Queue "join" messages for all online users, to populate the client's roster.
    // this.sessions.forEach(otherSession => {
    //   if (otherSession.name) {
    //     session.blockedMessages.push(JSON.stringify({joined: otherSession.name}));
    //   }
    // });

    // respond back to the client
    const respondToSelf = message => {
      session.webSocket.send(message);
    };

    // send a message to everyone on the list except us
    const proxyMessageToPeers = m => {
      for (const s of this.sessions) {
        if (s !== session) {
          s.webSocket.send(m);
        }
      }
    };
    // send a message to all peers
    const reflectMessageToPeers = m => {
      for (const s of this.sessions) {
        s.webSocket.send(m);
      }
    };

    // Load the last 100 messages from the chat history stored on disk, and send them to the
    // client.
    // let storage = await this.storage.list({reverse: true, limit: 100});
    /* let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    }); */

    const handleBinaryMessage = (arrayBuffer) => {
      const uint8Array = new Uint8Array(arrayBuffer);
      const updateObject = parseUpdateObject(uint8Array);

      const {method, args} = updateObject;
      if (NetworkedDataClient.handlesMethod(method)) {
        const {rollback, update} = dataClient.applyUint8Array(uint8Array);
        if (rollback) {
          const rollbackBuffer = serializeMessage(rollback);
          respondToSelf(rollbackBuffer);
        }
        if (update) {
          dataClient.emitUpdate(update);
          proxyMessageToPeers(uint8Array);
        }
      }
      if (NetworkedCrdtClient.handlesMethod(method)) {
        const [update] = args;
        crdtClient.update(update);
        proxyMessageToPeers(uint8Array);
      }
      if (NetworkedLockClient.handlesMethod(method)) {
        const m = (() => {
          const [lockName] = args;
          switch (method) {
            case UPDATE_METHODS.LOCK_REQUEST: {
              return new MessageEvent('lockRequest', {
                data: {
                  playerId,
                  lockName,
                },
              });
            }
            case UPDATE_METHODS.LOCK_RESPONSE: {
              return new MessageEvent('lockResponse', {
                data: {
                  playerId,
                  lockName,
                },
              });
            }
            case UPDATE_METHODS.LOCK_RELEASE: {
              return new MessageEvent('lockRelease', {
                data: {
                  playerId,
                  lockName,
                },
              });
            }
            default: {
              console.warn('unrecognized lock method', method);
              break
            }
          }
        })();
        lockClient.handle(m);
      }
      if (NetworkedIrcClient.handlesMethod(method)) {
        // console.log('route', method, args, this.sessions);
        reflectMessageToPeers(uint8Array);
      }
      if (
        networkedAudioClientHandlesMethod(method) ||
        networkedVideoClientHandlesMethod(method)
      ) {
        proxyMessageToPeers(uint8Array);
      }
    };

    const _sendJoinMessage = (playerId) => {
      if (playerId) {
        const joinMessage = new MessageEvent('join', {
          data: {
            playerId,
          },
        });
        const joinBuffer = serializeMessage(joinMessage);
        dataClient.emitUpdate(joinMessage);
        proxyMessageToPeers(joinBuffer);
      }
    };
    _sendJoinMessage(playerId);

    /* const _sendLeaveMessage = () => {
      console.log('send leave message', roomName, playerId);
      const leaveMessage = new MessageEvent('leave', {
        data: {
          playerId,
        },
      });
      const leaveBuffer = serializeMessage(leaveMessage);
      dataClient.emitUpdate(leaveMessage);
      proxyMessageToPeers(leaveBuffer);
    }; */

    // Set event handlers to receive messages.
    // let receivedUserInfo = false;
    webSocket.addEventListener("message", async msg => {
      try {
        if (session.quit) {
          // Whoops, when trying to send to this WebSocket in the past, it threw an exception and
          // we marked it broken. But somehow we got another message? I guess try sending a
          // close(), which might throw, in which case we'll try to send an error, which will also
          // throw, and whatever, at least we won't accept the message. (This probably can't
          // actually happen. This is defensive coding.)
          console.log('closing due to webasocket broken');
          webSocket.close(1011, "WebSocket broken.");
          return;
        }

        // Check if the user is over their rate limit and reject the message if so.
        /* if (!limiter.checkLimit()) {
          webSocket.send(JSON.stringify({
            error: "Your IP is being rate-limited, please try again later."
          }));
          return;
        } */

        if (msg.data instanceof ArrayBuffer) {
          const arrayBuffer = msg.data;
          handleBinaryMessage(arrayBuffer);
        } else {
          // I guess we'll use JSON.
          throw new Error('got non-binary message');
        }

        /* if (!receivedUserInfo) {
          // The first message the client sends is the user info message with their name. Save it
          // into their session object.
          session.name = "" + (data.name || "anonymous");

          // Don't let people use ridiculously long names. (This is also enforced on the client,
          // so if they get here they are not using the intended client.)
          if (session.name.length > 32) {
            webSocket.send(JSON.stringify({error: "Name too long."}));
            webSocket.close(1009, "Name too long.");
            return;
          }

          // Deliver all the messages we queued up since the user connected.
          session.blockedMessages.forEach(queued => {
            webSocket.send(queued);
          });
          delete session.blockedMessages;

          // Broadcast to all other connections that this user has joined.
          this.broadcast({joined: session.name});

          webSocket.send(JSON.stringify({ready: true}));

          // Note that we've now received the user info message.
          receivedUserInfo = true;

          return;
        }

        // Construct sanitized message for storage and broadcast.
        data = { name: session.name, message: "" + data.message };

        // Block people from sending overly long messages. This is also enforced on the client,
        // so to trigger this the user must be bypassing the client code.
        if (data.message.length > 256) {
          webSocket.send(JSON.stringify({error: "Message too long."}));
          return;
        }

        // Add timestamp. Here's where this.lastTimestamp comes in -- if we receive a bunch of
        // messages at the same time (or if the clock somehow goes backwards????), we'll assign
        // them sequential timestamps, so at least the ordering is maintained.
        data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
        this.lastTimestamp = data.timestamp;

        // Broadcast the message to all other WebSockets.
        let dataStr = JSON.stringify(data);
        this.broadcast(dataStr);

        // Save message.
        let key = new Date(data.timestamp).toISOString();
        await this.storage.put(key, dataStr); (*/
      } catch (err) {
        // Report any exceptions directly back to the client. As with our handleErrors() this
        // probably isn't what you'd want to do in production, but it's convenient when testing.
        console.warn(err);
        webSocket.send(JSON.stringify({error: err.stack}));
      }
    });

    // On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
    // a quit message.
    let closeOrErrorHandler = evt => {
      try {
        session.quit = true;
        this.sessions = this.sessions.filter(member => member !== session);

        _triggerDeadHands();
        _triggerUnlocks();

        // console.log('send leave', new Error().stack);
        // _sendLeaveMessage();

        /* if (session.name) {
          this.broadcast({quit: session.name});
        } */
      } catch(err) {
        console.warn(err.stack);
        throw err;
      } finally {
        cleanup();
      }
    };
    webSocket.addEventListener("close", closeOrErrorHandler);
    webSocket.addEventListener("error", closeOrErrorHandler);

    const cleanup = () => {
      webSocket.removeEventListener("close", closeOrErrorHandler);
      webSocket.removeEventListener("error", closeOrErrorHandler);
    };

    _resumeWebsocket();
  }

  // broadcast() broadcasts a message to all clients.
  broadcast(message) {
    // Apply JSON if we weren't given a string to start with.
    if (typeof message !== 'string') {
      message = JSON.stringify(message);
    }

    try {
      for (const session of this.sessions) {
        session.webSocket.send(message);
      }
    } catch (err) {
      console.warn(err.stack);
    }

    /* // Iterate over all the sessions sending them messages.
    let quitters = [];
    this.sessions = this.sessions.filter(session => {
      if (session.name) {
        try {
          session.webSocket.send(message);
          return true;
        } catch (err) {
          // Whoops, this connection is dead. Remove it from the list and arrange to notify
          // everyone below.
          session.quit = true;
          quitters.push(session);
          return false;
        }
      } else {
        // This session hasn't sent the initial user info message yet, so we're not sending them
        // messages yet (no secret lurking!). Queue the message to be sent later.
        // session.blockedMessages.push(message);
        return true;
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({quit: quitter.name});
      }
    }); */
  }
}

// =======================================================================================
// The RateLimiter Durable Object class.

// RateLimiter implements a Durable Object that tracks the frequency of messages from a particular
// source and decides when messages should be dropped because the source is sending too many
// messages.
//
// We utilize this in ChatRoom, above, to apply a per-IP-address rate limit. These limits are
// global, i.e. they apply across all chat rooms, so if a user spams one chat room, they will find
// themselves rate limited in all other chat rooms simultaneously.
export class RateLimiter {
  constructor(controller, env) {
    // Timestamp at which this IP will next be allowed to send a message. Start in the distant
    // past, i.e. the IP can send a message now.
    this.nextAllowedTime = 0;
  }

  // Our protocol is: POST when the IP performs an action, or GET to simply read the current limit.
  // Either way, the result is the number of seconds to wait before allowing the IP to perform its
  // next action.
  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;

      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

      if (request.method == "POST") {
        // POST request means the user performed an action.
        // We allow one action per 5 seconds.
        this.nextAllowedTime += 5;
      }

      // Return the number of seconds that the client needs to wait.
      //
      // We provide a "grace" period of 20 seconds, meaning that the client can make 4-5 requests
      // in a quick burst before they start being limited.
      let cooldown = Math.max(0, this.nextAllowedTime - now - 20);
      return new Response(cooldown);
    })
  }
}

// RateLimiterClient implements rate limiting logic on the caller's side.
class RateLimiterClient {
  // The constructor takes two functions:
  // * getLimiterStub() returns a new Durable Object stub for the RateLimiter object that manages
  //   the limit. This may be called multiple times as needed to reconnect, if the connection is
  //   lost.
  // * reportError(err) is called when something goes wrong and the rate limiter is broken. It
  //   should probably disconnect the client, so that they can reconnect and start over.
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;

    // Call the callback to get the initial stub.
    this.limiter = getLimiterStub();

    // When `inCooldown` is true, the rate limit is currently applied and checkLimit() will return
    // false.
    this.inCooldown = false;
  }

  // Call checkLimit() when a message is received to decide if it should be blocked due to the
  // rate limit. Returns `true` if the message should be accepted, `false` to reject.
  checkLimit() {
    if (this.inCooldown) {
      return false;
    }
    this.inCooldown = true;
    this.callLimiter();
    return true;
  }

  // callLimiter() is an internal method which talks to the rate limiter.
  async callLimiter() {
    try {
      let response;
      try {
        // Currently, fetch() needs a valid URL even though it's not actually going to the
        // internet. We may loosen this in the future to accept an arbitrary string. But for now,
        // we have to provide a dummy URL that will be ignored at the other end anyway.
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      } catch (err) {
        // `fetch()` threw an exception. This is probably because the limiter has been
        // disconnected. Stubs implement E-order semantics, meaning that calls to the same stub
        // are delivered to the remote object in order, until the stub becomes disconnected, after
        // which point all further calls fail. This guarantee makes a lot of complex interaction
        // patterns easier, but it means we must be prepared for the occasional disconnect, as
        // networks are inherently unreliable.
        //
        // Anyway, get a new limiter and try again. If it fails again, something else is probably
        // wrong.
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      }

      // The response indicates how long we want to pause before accepting more requests.
      let cooldown = +(await response.text());
      await new Promise(resolve => setTimeout(resolve, cooldown * 1000));

      // Done waiting.
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
    }
  }
}
