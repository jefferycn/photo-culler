FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libheif1 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir pillow pillow-heif
WORKDIR /app
COPY app/ ./app/
ENV PHOTOS_DIR=/photos DEST_DIR=/dest DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["python3", "app/server.py"]
