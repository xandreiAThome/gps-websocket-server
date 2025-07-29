FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (if present)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY . .

# Build TypeScript (if needed)
RUN npm run build || true

# Expose port (default 8080, can be overridden)
EXPOSE 8080

# Start the server
CMD ["node", "dist/index.js"]# Use official Node.js LTS image
FROM node:20-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY . .

# Expose port (default 8080)
EXPOSE 8080

# Start the server
CMD ["npm", "start"]
