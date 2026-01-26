#!/bin/bash

# Navigate to agentic directory (script's parent directory)
cd "$(dirname "$0")/.." || exit 1

# Track if we created the venv
CREATED_VENV=false

# Cleanup function
cleanup() {
    echo ""
    echo "Cleaning up..."
    if [ "$CREATED_VENV" = true ] && [ -d "venv" ]; then
        echo "Removing virtual environment..."
        rm -rf venv
    fi
    echo "Done."
    exit 0
}

# Trap signals to run cleanup on exit
trap cleanup SIGINT SIGTERM EXIT

# Setup pyenv if available
export PYENV_ROOT="$HOME/.pyenv"
[[ -d $PYENV_ROOT/bin ]] && export PATH="$PYENV_ROOT/bin:$PATH"
if command -v pyenv &> /dev/null; then
    eval "$(pyenv init -)"
fi

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python -m venv venv
    CREATED_VENV=true
fi

# Activate virtual environment
source venv/bin/activate

# Install dependencies if not already installed
if ! python -c "import fastapi" &> /dev/null; then
    echo "Installing dependencies..."
    pip install -r requirements.txt
fi

# Run the agent
python agent.py
