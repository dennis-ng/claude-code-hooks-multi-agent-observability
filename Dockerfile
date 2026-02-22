FROM python:3.12-slim
WORKDIR /app
COPY apps/server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/server/ ./server/
COPY apps/client/ ./client/
RUN mkdir -p /app/data
EXPOSE 4000
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "4000"]
