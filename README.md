# GPS Bus Tracking WebSocket Server

A TypeScript WebSocket server for real-time GPS bus tracking with multi-client support.

## Features

- \*\*Multi-cl## Client Types

- **`bus_driver`**: Can send location updates for their assigned bus (must register with busId)
- **`passenger`**: Can only receive location updates from buses they subscribe to
- **`admin`**: Can both send and receive location updates for monitoring purposesSupport\*\*: Multiple clients can both broadcast and receive locations
- **Selective Subscription**: Clients can subscribe to receive updates from one specific broadcaster
- **Real-time Location Broadcasting**: Live GPS tracking for multiple buses
- **Client Role Management**: Clients can be broadcasters, receivers, or both
- **TypeScript Support**: Strict type checking and comprehensive interfaces
- **Bus-specific Updates**: Clients only receive location updates from their subscribed bus
- **Client Information Tracking**: Monitor connected clients and their roles
- **Error Handling**: Robust error handling and graceful shutdown

## Installation

```bash
npm install
```

## Development

```bash
# Run in development mode with auto-reload
npm run dev

# Watch mode for development
npm run watch
```

## Production

```bash
# Build the project
npm run build

# Start the production server
npm start
```

## Usage

### Starting the Server

The server will start on port 8080 by default (or the PORT environment variable).

```bash
npm run dev
```

Connect to: `ws://localhost:8080`

### Message Types

#### Client to Server

**Register Client:**

```json
{
  "type": "register",
  "clientType": "bus_driver",
  "busId": "bus_001",
  "userId": "driver_123"
}
```

**Location Update:**

```json
{
  "type": "location_update",
  "data": {
    "latitude": 14.5995,
    "longitude": 120.9842,
    "accuracy": 10,
    "timestamp": 1641234567890,
    "busId": "bus_001",
    "userId": "user_123"
  }
}
```

**Subscribe to Updates from Specific Bus:**

```json
{
  "type": "subscribe",
  "subscribeToBusId": "bus_001"
}
```

**Unsubscribe:**

```json
{
  "type": "unsubscribe"
}
```

#### Server to Client

**Connection Acknowledgment:**

```json
{
  "type": "connection_ack",
  "message": "Connected to GPS tracking server",
  "clientCount": 5
}
```

**Location Broadcast:**

```json
{
  "type": "location_broadcast",
  "data": {
    "latitude": 14.5995,
    "longitude": 120.9842,
    "accuracy": 10,
    "timestamp": 1641234567890,
    "busId": "bus_001",
    "userId": "driver_123"
  }
}
```

**Client List Update:**

```json
{
  "type": "client_list",
  "clientCount": 3,
  "activeBuses": ["bus_001", "bus_002"],
  "clients": [
    {
      "id": "abc123def",
      "type": "both",
      "busId": "bus_001",
      "userId": "driver_123",
      "connected": true
    }
  ]
}
```

**Error:**

```json
{
  "type": "error",
  "message": "Client not authorized to broadcast location"
}
```

## Client Types

- **`broadcaster`**: Can only send location updates
- **`receiver`**: Can only receive location updates
- **`both`**: Can both send and receive location updates (default)

## How It Works

1. **Connection**: Clients connect to the server (default as passengers)
2. **Registration**: Bus drivers must register with their busId to send location updates
3. **Subscription**: Passengers subscribe to specific buses to receive location updates
4. **Broadcasting**: Only bus drivers and admins can send location updates for their assigned bus
5. **Receiving**: Subscribed clients receive location broadcasts only from their subscribed bus
6. **Client Management**: Server tracks all connected clients and their bus assignments/subscriptions

## Usage Examples

**Bus Driver:**

```json
// Register as bus driver (required to send location updates)
{"type": "register", "clientType": "bus_driver", "busId": "bus_001", "userId": "driver_123"}

// Send location updates for your assigned bus
{"type": "location_update", "data": {"latitude": 14.5995, "longitude": 120.9842, "timestamp": 1641234567890}}

// Optionally monitor another bus
{"type": "subscribe", "subscribeToBusId": "bus_002"}
```

**Passenger:**

```json
// Register as passenger (optional)
{"type": "register", "clientType": "passenger", "userId": "passenger_456"}

// Subscribe to track a specific bus
{"type": "subscribe", "subscribeToBusId": "bus_001"}

// Switch to track a different bus
{"type": "subscribe", "subscribeToBusId": "bus_003"}
```

**Admin/Monitoring:**

```json
// Register as admin
{"type": "register", "clientType": "admin", "userId": "admin_001"}

// Monitor specific bus
{"type": "subscribe", "subscribeToBusId": "bus_001"}

// Send test location updates (if needed)
{"type": "location_update", "data": {"latitude": 14.5995, "longitude": 120.9842, "timestamp": 1641234567890}}
```

````

**Error:**

```json
{
  "type": "error",
  "message": "Invalid message format"
}
````

## Environment Variables

- `PORT`: Server port (default: 8080)

## TypeScript Types

The server exports the following TypeScript interfaces:

- `LocationData`: GPS location information
- `ClientMessage`: Messages sent from client to server
- `ServerMessage`: Messages sent from server to client
