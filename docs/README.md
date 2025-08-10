# FBI-Proxy Documentation

This directory contains the documentation for FBI-Proxy, which is automatically deployed to GitHub Pages at https://snomiao.github.io/fbi-proxy.

## Local Development

To run the documentation site locally:

```bash
cd docs

# Install dependencies
gem install bundler
bundle install

# Run local server
bundle exec jekyll serve

# Open http://localhost:4000/fbi-proxy
```

## Documentation Structure

- `index.md` - Main documentation homepage
- `installation.md` - Installation guide
- `usage.md` - Usage instructions and examples
- `development.md` - Development setup and contributing
- `docker.md` - Docker deployment guide
- `api.md` - API reference
- `troubleshooting.md` - Common issues and solutions

## Deployment

Documentation is automatically deployed to GitHub Pages when changes are pushed to the `main` branch. The deployment is handled by the `.github/workflows/docs.yml` workflow.

## Configuration

- `_config.yml` - Jekyll site configuration
- `Gemfile` - Ruby dependencies for Jekyll
- GitHub Pages uses the `minima` theme by default
