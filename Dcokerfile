# Use a lightweight, stable Node environment
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package requirements and install
COPY package*.json ./
RUN npm install

# Copy the entire project (including SKILL.md and hermes-brain.js)
COPY . .

# Expose the port the Agent listens on
EXPOSE 8000

# Command to boot the Agent
CMD ["node", "hermes-brain.js"]