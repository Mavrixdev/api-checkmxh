#!/usr/bin/env bash
# exit on error
set -o errexit

npm install
# Install Chrome dependencies for Puppeteer on Render
# (Note: This is for Render's Linux environment)
# If you use Render's Docker, you can ignore this.
# For regular Web Service, you might need a different approach (like a Dockerfile), 
# but these are the common libs needed.
