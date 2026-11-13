FROM node:20-slim

# yt-dlp dipasang sebagai file mandiri di folder milik user "node" (bukan lewat pip), supaya
# "yt-dlp -U" bisa memperbarui dirinya sendiri saat server berjalan tanpa hak root.
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    ca-certificates \
    --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/yt-dlp \
    && curl -sSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /opt/yt-dlp/yt-dlp \
    && chmod 755 /opt/yt-dlp/yt-dlp \
    && chown -R node:node /opt/yt-dlp
ENV PATH="/opt/yt-dlp:${PATH}"

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

ENV PORT=8080
EXPOSE 8080
# Jalankan sebagai user biasa, bukan root, supaya dampak celah apa pun lebih kecil.
USER node
CMD ["node", "server.js"]
