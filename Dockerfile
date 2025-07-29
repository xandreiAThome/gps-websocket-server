FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json (if present)
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm install

# Copy source code
COPY . .

# Build TypeScript to dist/
RUN npm run build

# --- Production image ---
FROM node:20-alpine AS production
WORKDIR /app

# Copy only production dependencies
COPY package*.json ./
RUN npm install --production

# Copy built code and assets from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/README.md ./

# Expose port (default 8080)
EXPOSE 8080

# Start the server
CMD ["node", "dist/index.js"]
