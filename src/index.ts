import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "http";
import { networkInterfaces } from "os";

interface LocationData {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: number;
}

interface BroadcastLocationData extends LocationData {
  busId: string;
  userId: string;
}

interface ClientMessage {
  type: "location_update" | "subscribe" | "unsubscribe" | "register";
  data?: LocationData;
  busId?: string;
  userId?: string;
  clientType: "bus_driver" | "admin" | "passenger";
  subscribeToBusId?: string;
}

interface ClientInfo {
  id: string;
  type: "bus_driver" | "admin" | "passenger";
  busId?: string;
  userId: string;
  lastLocation?: LocationData;
  connected: boolean;
  subscribedToBusId?: string | undefined;
}

interface ServerMessage {
  type: "location_broadcast" | "connection_ack" | "error" | "client_list";
  data?: BroadcastLocationData;
  message?: string;
  clientCount?: number;
  activeBuses?: string[];
  clients?: ClientInfo[];
}

const server = createServer();
const wss = new WebSocketServer({ server });

const clients = new Map<WebSocket, ClientInfo>();
const busLocations = new Map<string, BroadcastLocationData>();
const busSubscriptions = new Map<string, Set<WebSocket>>();

wss.on("connection", (ws: WebSocket) => {
  console.log("new client connected ");

  const clientInfo: ClientInfo = {
    id: generateClientId(),
    type: "passenger", //default
    userId: "", // will be set on registration
    connected: true,
  };

  clients.set(ws, clientInfo);

  const ackMessage: ServerMessage = {
    type: "connection_ack",
    message: "Connected to GPS tracking server",
    clientCount: clients.size,
  };

  ws.send(JSON.stringify(ackMessage));

  broadcastClientListToSingle(ws);

  ws.on("message", (message: WebSocket.Data) => {
    try {
      const parsedMsg: ClientMessage = JSON.parse(message.toString());
      handleClientMessage(ws, parsedMsg);
    } catch (err) {}
  });

  ws.on("close", () => {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      console.log(
        `Client ${clientInfo.id} (${clientInfo.userId}) disconnected`
      );

      // Store bus info for potential subscriber notification
      const wasBusDriver = clientInfo.type === "bus_driver" && clientInfo.busId;
      const busId = clientInfo.busId;

      // Clean up subscriptions
      if (clientInfo.subscribedToBusId) {
        const subscribers = busSubscriptions.get(clientInfo.subscribedToBusId);
        if (subscribers) {
          subscribers.delete(ws);
          if (subscribers.size === 0) {
            busSubscriptions.delete(clientInfo.subscribedToBusId);
          }
        }
      }

      // Remove client from clients map
      clients.delete(ws);

      // If this was a bus driver, check if there are other drivers for this bus
      if (wasBusDriver && busId) {
        const otherDrivers = Array.from(clients.values()).filter(
          (client) => client.type === "bus_driver" && client.busId === busId
        );

        if (otherDrivers.length === 0) {
          // No other drivers for this bus, remove location data
          busLocations.delete(busId);
          console.log(
            `Bus ${busId} went offline - no active drivers remaining`
          );

          // Notify subscribers of this specific bus
          const subscribers = busSubscriptions.get(busId);
          if (subscribers && subscribers.size > 0) {
            const offlineMessage: ServerMessage = {
              type: "error",
              message: `Bus ${busId} went offline`,
            };

            const jsonMessage = JSON.stringify(offlineMessage);
            subscribers.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(jsonMessage);
              }
            });

            // Send updated client list to subscribers of this bus
            const updatedClientList: ClientInfo[] = Array.from(
              clients.values()
            );
            const activeBuses = Array.from(busLocations.keys());

            const clientListMessage: ServerMessage = {
              type: "client_list",
              clients: updatedClientList,
              activeBuses: activeBuses,
              clientCount: clients.size,
            };

            const clientListJson = JSON.stringify(clientListMessage);
            subscribers.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(clientListJson);
              }
            });

            console.log(
              `Sent updated client list to ${subscribers.size} subscribers of bus ${busId}`
            );
          }
        }
      }

      // Broadcast updated client list to all clients
      broadcastClientList();
    }
  });
});

function handleClientMessage(ws: WebSocket, message: ClientMessage) {
  const clientInfo = clients.get(ws);

  if (!clientInfo) return;

  switch (message.type) {
    case "register":
      if (!message.userId) {
        const errMsg: ServerMessage = {
          type: "error",
          message: "register first with userId",
        };
        ws.send(JSON.stringify(errMsg));
        return;
      }

      if (message.clientType) {
        if (message.clientType === "bus_driver" && !message.busId) {
          const errMsg: ServerMessage = {
            type: "error",
            message: "bus_driver must register with busId",
          };
          ws.send(JSON.stringify(errMsg));
          return;
        } else if (message.clientType !== "bus_driver" && message.busId) {
          const errMsg: ServerMessage = {
            type: "error",
            message: "clientTypes that are not bus drivers must not have busId",
          };
          ws.send(JSON.stringify(errMsg));
          return;
        }

        clientInfo.type = message.clientType;
        if (message.busId) clientInfo.busId = message.busId;
        clientInfo.userId = message.userId;

        console.log(
          `Client ${clientInfo.userId} (${clientInfo.id}) registered as ${
            clientInfo.type
          }${clientInfo.busId ? ` for bus ${clientInfo.busId}` : ""}`
        );

        broadcastClientList();
        break;
      }

    case "location_update":
      if (!message.userId) {
        const errMsg: ServerMessage = {
          type: "error",
          message: "register first with userId",
        };
        ws.send(JSON.stringify(errMsg));
        return;
      }

      if (
        message.data &&
        (clientInfo.type === "bus_driver" || clientInfo.type === "admin") &&
        clientInfo.busId
      ) {
        const broadcastLocData: BroadcastLocationData = {
          ...message.data,
          busId: clientInfo.busId,
          userId: clientInfo.userId,
        };

        clientInfo.lastLocation = broadcastLocData;
        handleLocationUpdate(broadcastLocData);
      } else if (!clientInfo.busId) {
        const errorMessage: ServerMessage = {
          type: "error",
          message: "Must register with a busId to send location updates",
        };
        ws.send(JSON.stringify(errorMessage));
      } else {
        const errorMessage: ServerMessage = {
          type: "error",
          message: "Only bus drivers and admins can broadcast location updates",
        };
        ws.send(JSON.stringify(errorMessage));
      }
      break;

    case "subscribe":
      if (!message.userId) {
        const errMsg: ServerMessage = {
          type: "error",
          message: "register first with userId",
        };
        ws.send(JSON.stringify(errMsg));
        return;
      }

      if (!message.subscribeToBusId) {
        const errorMessage: ServerMessage = {
          type: "error",
          message: "Must specify busId to subscribe to",
        };
        ws.send(JSON.stringify(errorMessage));
        return;
      }

      if (clientInfo.subscribedToBusId) {
        const oldSubscribers = busSubscriptions.get(
          clientInfo.subscribedToBusId
        );
        if (oldSubscribers) {
          oldSubscribers.delete(ws);
          if (oldSubscribers.size === 0) {
            busSubscriptions.delete(clientInfo.subscribedToBusId);
          }
        }
      }

      clientInfo.subscribedToBusId = message.subscribeToBusId;

      if (!busSubscriptions.has(message.subscribeToBusId)) {
        busSubscriptions.set(message.subscribeToBusId, new Set());
      }
      busSubscriptions.get(message.subscribeToBusId)!.add(ws);

      console.log(
        `Client ${clientInfo.id} subscribed to bus ${message.subscribeToBusId}`
      );

      const currLoc = busLocations.get(message.subscribeToBusId);
      if (currLoc) {
        const locationMsg: ServerMessage = {
          type: "location_broadcast",
          data: currLoc,
        };
        ws.send(JSON.stringify(locationMsg));
      }
      break;

    case "unsubscribe":
      if (!message.userId) {
        const errMsg: ServerMessage = {
          type: "error",
          message: "register first with userId",
        };
        ws.send(JSON.stringify(errMsg));
        return;
      }

      if (clientInfo.subscribedToBusId) {
        const subscribers = busSubscriptions.get(clientInfo.subscribedToBusId);
        if (subscribers) {
          subscribers.delete(ws);
          if (subscribers.size === 0) {
            busSubscriptions.delete(clientInfo.subscribedToBusId);
          }
        }
        console.log(
          `Client ${clientInfo.id} unsubscribed from bus ${clientInfo.subscribedToBusId}`
        );
        clientInfo.subscribedToBusId = undefined;
      }
      break;

    default:
      const errorMessage: ServerMessage = {
        type: "error",
        message: "Unknown message type",
      };
      ws.send(JSON.stringify(errorMessage));
      break;
  }
}

function handleLocationUpdate(locationData: BroadcastLocationData) {
  const busId = locationData.busId;
  busLocations.set(busId, locationData);

  const subscribedClients = busSubscriptions.get(busId);
  if (subscribedClients && subscribedClients.size > 0) {
    const broadcastMessage: ServerMessage = {
      type: "location_broadcast",
      data: locationData,
    };

    const jsonMessage = JSON.stringify(broadcastMessage);

    subscribedClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(jsonMessage);
      }
    });

    console.log(
      `Location updated for bus ${busId} - broadcasted to ${subscribedClients.size} subscribers:`,
      {
        lat: locationData.latitude.toFixed(6),
        lng: locationData.longitude.toFixed(6),
        timestamp: new Date(locationData.timestamp).toISOString(),
      }
    );
  } else {
    console.log(`Location updated for bus ${busId} - no subscribers:`, {
      lat: locationData.latitude.toFixed(6),
      lng: locationData.longitude.toFixed(6),
      timestamp: new Date(locationData.timestamp).toISOString(),
    });
  }
}

// Helper functions
function generateClientId(): string {
  return Math.random().toString(36).substr(2, 9);
}

function broadcastClientListToSingle(ws: WebSocket) {
  const clientList: ClientInfo[] = Array.from(clients.values());
  const activeBuses = Array.from(busLocations.keys());

  const msg: ServerMessage = {
    type: "client_list",
    clients: clientList,
    activeBuses: activeBuses,
    clientCount: clients.size,
  };

  ws.send(JSON.stringify(msg));
}

function broadcastClientList() {
  const clientList: ClientInfo[] = Array.from(clients.values());
  const activeBuses = Array.from(busLocations.keys());

  const msg: ServerMessage = {
    type: "client_list",
    clients: clientList,
    activeBuses: activeBuses,
    clientCount: clients.size,
  };

  const jsonMsg = JSON.stringify(msg);

  clients.forEach((_, client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(jsonMsg);
    }
  });
}

const PORT = Number(process.env["PORT"]) || 8080;
const HOST = "0.0.0.0"; // Bind to all interfaces

server.listen(PORT, HOST, () => {
  console.log(`🚀 GPS WebSocket server is running on ${HOST}:${PORT}`);
  console.log(`📱 Local access: ws://localhost:${PORT}`);

  // Display all available network addresses
  const interfaces = networkInterfaces();
  console.log("\n🔗 Connect from React Native using one of these URLs:");

  Object.keys(interfaces).forEach((name) => {
    interfaces[name]?.forEach((net) => {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`   ws://${net.address}:${PORT}`);
      }
    });
  });

  console.log("\n📱 For Android Emulator use: ws://10.0.2.2:8080");
  console.log("📱 For iOS Simulator use: ws://localhost:8080");
  console.log("📱 For Physical Devices use one of the IP addresses above\n");
});

process.on("SIGINT", () => {
  console.log("Shutting down server");
  wss.close(() => {
    server.close(() => {
      console.log("server closed");
      process.exit(0);
    });
  });
});
