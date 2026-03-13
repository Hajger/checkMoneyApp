# Použijeme oficiální prostředí pro Node.js
FROM node:20

# Vytvoříme pracovní složku na serveru
WORKDIR /app

# Zkopírujeme informace o knihovnách a nainstalujeme je
COPY package*.json ./
RUN npm install

# Zkopírujeme zbytek našeho kódu
COPY . .

# Otevřeme port 3000 do světa
EXPOSE 3000

# Příkaz pro spuštění aplikace
CMD ["npm", "start"]