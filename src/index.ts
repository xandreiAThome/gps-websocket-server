import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "http";

// Define types for our bus tracking application
// System Design:
// - bus_driver: Sends location updates for their assigned bus
// - passenger: Receives location updates from buses they subscribe to
// - admin: Can both send and receive location updates for monitoring

// Raw location data (just GPS coordinates without user/bus metadata)
interface LocationData {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: number;
}

// Complete location data with server-added metadata for broadcasting
interface BroadcastLocationData extends LocationData {
  busId: string;
  userId: string;
}

interface ClientMessage {
  type: "location_update" | "subscribe" | "unsubscribe" | "register";
  data?: LocationData; // Just the GPS coordinates
  busId?: string; // Used for registration and location updates
  userId?: string; // Used for registration
  clientType?: "bus_driver" | "passenger" | "admin";
  subscribeToBusId?: string; // Specific bus to subscribe to
}

interface ServerMessage {
  type: "location_broadcast" | "connection_ack" | "error" | "client_list";
  data?: BroadcastLocationData;
  message?: string;
  clientCount?: number;
  activeBuses?: string[];
  clients?: ClientInfo[];
}

interface ClientInfo {
  id: string;
  type: "bus_driver" | "passenger" | "admin"; // More specific roles
  busId?: string;
  userId: string;
  lastLocation?: BroadcastLocationData;
  connected: boolean;
  subscribedToBusId?: string | undefined; // Which bus this client is subscribed to
}

// Create HTTP server
const server = createServer();
const wss = new WebSocketServer({ server });

// Store connected clients with extended information
const clients = new Map<WebSocket, ClientInfo>();
const busLocations = new Map<string, BroadcastLocationData>();
// Map of busId to Set of subscribed clients
const busSubscriptions = new Map<string, Set<WebSocket>>();

wss.on("connection", (ws: WebSocket) => {
  console.log("New client connected");

  // Initialize client info
  const clientInfo: ClientInfo = {
    id: generateClientId(),
    type: "passenger", // Default to passenger - must register as bus_driver to broadcast
    userId: "", // Will be set during registration
    connected: true,
  };

  clients.set(ws, clientInfo);
  // No auto-subscription - clients must explicitly subscribe to a specific bus

  // Send connection acknowledgment
  const ackMessage: ServerMessage = {
    type: "connection_ack",
    message: "Connected to GPS tracking server",
    clientCount: clients.size,
  };
  ws.send(JSON.stringify(ackMessage));

  // Send current client and bus information
  broadcastClientListToSingle(ws);

  // Handle incoming messages
  ws.on("message", (message: WebSocket.Data) => {
    try {
      const parsedMessage: ClientMessage = JSON.parse(message.toString());
      handleClientMessage(ws, parsedMessage);
    } catch (error) {
      console.error("Error parsing message:", error);
      const errorMessage: ServerMessage = {
        type: "error",
        message: "Invalid message format",
      };
      ws.send(JSON.stringify(errorMessage));
    }
  });

  // Handle client disconnect
  ws.on("close", () => {
    const clientInfo = clients.get(ws);
    console.log(`Client disconnected: ${clientInfo?.id || "unknown"}`);

    // Remove from bus subscriptions
    if (clientInfo?.subscribedToBusId) {
      const subscribers = busSubscriptions.get(clientInfo.subscribedToBusId);
      if (subscribers) {
        subscribers.delete(ws);
        if (subscribers.size === 0) {
          busSubscriptions.delete(clientInfo.subscribedToBusId);
        }
      }
    }

    clients.delete(ws);
  });

  // Handle errors
  ws.on("error", (error: Error) => {
    const clientInfo = clients.get(ws);
    console.error(
      `WebSocket error for client ${clientInfo?.id || "unknown"}:`,
      error
    );

    // Remove from bus subscriptions
    if (clientInfo?.subscribedToBusId) {
      const subscribers = busSubscriptions.get(clientInfo.subscribedToBusId);
      if (subscribers) {
        subscribers.delete(ws);
        if (subscribers.size === 0) {
          busSubscriptions.delete(clientInfo.subscribedToBusId);
        }
      }
    }

    clients.delete(ws);
  });
});

function handleClientMessage(ws: WebSocket, message: ClientMessage): void {
  const clientInfo = clients.get(ws);
  if (!clientInfo) return;

  switch (message.type) {
    case "register":
      // Require userId for all clients
      if (!message.userId) {
        const errorMessage: ServerMessage = {
          type: "error",
          message: "userId is required during registration",
        };
        ws.send(JSON.stringify(errorMessage));
        return;
      }

      // Client registers with specific type and IDs
      if (message.clientType) {
        // Validate that bus drivers register with a busId
        if (message.clientType === "bus_driver" && !message.busId) {
          const errorMessage: ServerMessage = {
            type: "error",
            message: "Bus drivers must register with a busId",
          };
          ws.send(JSON.stringify(errorMessage));
          return;
        }

        clientInfo.type = message.clientType;
      }
      if (message.busId) {
        clientInfo.busId = message.busId;
      }

      clientInfo.userId = message.userId;

      console.log(
        `Client ${clientInfo.userId} (${clientInfo.id}) registered as ${
          clientInfo.type
        }${clientInfo.busId ? ` for bus ${clientInfo.busId}` : ""}`
      );

      // Send updated client info to all clients
      broadcastClientList();
      break;

    case "location_update":
      // Only bus drivers and admins can send location updates, and they must have a busId
      if (
        message.data &&
        (clientInfo.type === "bus_driver" || clientInfo.type === "admin") &&
        clientInfo.busId
      ) {
        // Create complete location data with server-added metadata
        const broadcastLocationData: BroadcastLocationData = {
          ...message.data,
          busId: clientInfo.busId,
          userId: clientInfo.userId,
        };

        clientInfo.lastLocation = broadcastLocationData;
        handleLocationUpdate(broadcastLocationData);
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
      // Client wants to receive location updates from a specific bus
      if (!message.subscribeToBusId) {
        const errorMessage: ServerMessage = {
          type: "error",
          message: "Must specify busId to subscribe to",
        };
        ws.send(JSON.stringify(errorMessage));
        return;
      }

      // Unsubscribe from previous bus if any
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

      // Subscribe to new bus
      clientInfo.subscribedToBusId = message.subscribeToBusId;

      if (!busSubscriptions.has(message.subscribeToBusId)) {
        busSubscriptions.set(message.subscribeToBusId, new Set());
      }
      busSubscriptions.get(message.subscribeToBusId)!.add(ws);

      console.log(
        `Client ${clientInfo.id} subscribed to bus ${message.subscribeToBusId}`
      );

      // Send current location of the subscribed bus if available
      const currentLocation = busLocations.get(message.subscribeToBusId);
      if (currentLocation) {
        const locationMessage: ServerMessage = {
          type: "location_broadcast",
          data: currentLocation,
        };
        ws.send(JSON.stringify(locationMessage));
      }
      break;

    case "unsubscribe":
      // Client no longer wants location updates
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
  }
}

function handleLocationUpdate(locationData: BroadcastLocationData): void {
  // Store the location data
  const busId = locationData.busId;
  busLocations.set(busId, locationData);

  // Broadcast only to clients subscribed to this specific bus
  const subscribedClients = busSubscriptions.get(busId);
  if (subscribedClients && subscribedClients.size > 0) {
    const broadcastMessage: ServerMessage = {
      type: "location_broadcast",
      data: locationData,
    };

    const messageString = JSON.stringify(broadcastMessage);

    subscribedClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageString);
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

function broadcastClientListToSingle(ws: WebSocket): void {
  const clientsList: ClientInfo[] = Array.from(clients.values());
  const activeBuses = Array.from(busLocations.keys());

  const message: ServerMessage = {
    type: "client_list",
    clients: clientsList,
    activeBuses: activeBuses,
    clientCount: clients.size,
  };
  ws.send(JSON.stringify(message));
}

function broadcastClientList(): void {
  const clientsList: ClientInfo[] = Array.from(clients.values());
  const activeBuses = Array.from(busLocations.keys());

  const message: ServerMessage = {
    type: "client_list",
    clients: clientsList,
    activeBuses: activeBuses,
    clientCount: clients.size,
  };

  const messageString = JSON.stringify(message);

  clients.forEach((_, client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageString);
    }
  });
}

// Start the server
const PORT = process.env["PORT"] || 8080;
server.listen(PORT, () => {
  console.log(`GPS WebSocket server is running on port ${PORT}`);
  console.log(`Connect to: ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down server...");
  wss.close(() => {
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });
});

export {
  LocationData,
  BroadcastLocationData,
  ClientMessage,
  ServerMessage,
  ClientInfo,
};
