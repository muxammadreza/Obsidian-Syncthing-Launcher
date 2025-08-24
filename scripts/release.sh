#!/bin/bash

# Obsidian Plugin Release Script
# This script ensures consistent versioning across all files and creates a proper release

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 Obsidian Plugin Release Script${NC}"

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo -e "${RED}❌ Error: Not in a git repository${NC}"
    exit 1
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    echo -e "${RED}❌ Error: You have uncommitted changes. Please commit or stash them first.${NC}"
    exit 1
fi

# Get the version to release
if [ -z "$1" ]; then
    echo -e "${YELLOW}📝 Please provide a version number (e.g., 1.2.5, patch, minor, major):${NC}"
    read -p "Version: " VERSION
else
    VERSION=$1
fi

echo -e "${GREEN}🔄 Setting version to: $VERSION${NC}"

# Update package.json version and run version-bump script
npm version $VERSION --no-git-tag-version

# Build the plugin
echo -e "${GREEN}🔨 Building plugin...${NC}"
npm run build

# Check if build was successful
if [ ! -f "main.js" ]; then
    echo -e "${RED}❌ Build failed: main.js not found${NC}"
    exit 1
fi

# Get the actual version from package.json
ACTUAL_VERSION=$(node -p "require('./package.json').version")

echo -e "${GREEN}✅ Version synchronized across all files: $ACTUAL_VERSION${NC}"

# Add all changed files
git add .

# Commit the changes
echo -e "${GREEN}📝 Committing version $ACTUAL_VERSION...${NC}"
git commit -m "🔖 Release v$ACTUAL_VERSION

- Updated version in package.json, manifest.json, and versions.json
- Built plugin files
- Ready for release"

# Create and push the tag
echo -e "${GREEN}🏷️  Creating and pushing tag v$ACTUAL_VERSION...${NC}"
git tag "v$ACTUAL_VERSION"
git push origin main
git push origin "v$ACTUAL_VERSION"

# Create GitHub release
echo -e "${GREEN}🚀 Creating GitHub release...${NC}"
gh release create "v$ACTUAL_VERSION" \
    --title "v$ACTUAL_VERSION" \
    --generate-notes \
    main.js manifest.json styles.css

echo -e "${GREEN}🎉 Release v$ACTUAL_VERSION completed successfully!${NC}"
echo -e "${YELLOW}📦 Files included in release: main.js, manifest.json, styles.css${NC}"
