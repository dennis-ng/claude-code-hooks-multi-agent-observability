FROM python:3.12-slim
WORKDIR /app
COPY commander-ui/server/ ./server/
COPY commander-ui/client/ ./client/
RUN pip install --no-cache-dir fastapi uvicorn aiosqlite pydantic
RUN mkdir -p /app/data
EXPOSE 4200
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "4200"]
