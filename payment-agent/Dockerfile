FROM public.ecr.aws/docker/library/python:3.12-slim

# System deps for building native extensions.
# The AgentCore Browser tool runs Chromium in a managed cloud service, so no
# local browser runtime deps are required.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy agent source
COPY . .

# Non-root user
RUN useradd -m -r agent && chown -R agent:agent /app
USER agent

EXPOSE 8080
CMD ["python", "agent.py"]
