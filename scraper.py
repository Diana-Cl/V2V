import os
import re
import json
import base64
import requests
from urllib.parse import urlparse, parse_qs, quote
from github import Github, Auth

# Constants
# The token is read from an environment variable for security
GH_PAT = os.environ.get('GH_PAT')
# The file that contains the list of sources for configs
SOURCES_FILE = "sources.json"
# The file to which the live configs will be written
LIVE_CONFIGS_FILE = "all_live_configs.json"
# The file to which the clash configs will be written
CLASH_CONFIGS_FILE = "clash_configs.yaml"
# The file to which the sing-box configs will be written
SINGBOX_CONFIGS_FILE = "singbox_configs.json"
# The file that contains the clash configurations
CLASH_CONFIG_FILE = "clash.yaml"
# The file that contains the sing-box configurations
SINGBOX_CONFIG_FILE = "singbox.json"

# List of protocols that are supported by the script
SUPPORTED_PROTOCOLS = ["vmess", "vless", "trojan", "ss", "ss-aead", "socks", "http"]

# Initialize the final configs dictionary
final_configs = {"xray": [], "singbox": []}

def is_valid_protocol(config_str):
    """
    Check if the given config string is a valid protocol.
    """
    return any(proto in config_str for proto in SUPPORTED_PROTOCOLS)

def fetch_configs_from_url(url):
    """
    Fetch configs from the given URL.
    """
    try:
        # Timeout increased for better reliability
        response = requests.get(url, timeout=10)
        if response.status_code == 200:
            return response.text.splitlines()
    except requests.exceptions.RequestException as e:
        print(f"Error fetching configs from {url}: {e}")
    return []

def search_github_for_configs():
    """
    Search GitHub for configs.
    """
    auth = Auth.Token(GH_PAT)
    g = Github(auth=auth)

    # Search for files that contain the supported protocols and have the .txt extension
    query = ' OR '.join([f'"{ext}"' for ext in SUPPORTED_PROTOCOLS]) + ' extension:txt'
    repositories = g.search_code(query)

    print(f"Found {repositories.totalCount} code results")

    # Limit the number of repositories to 200 to avoid hitting the rate limit
    repo_limit = 200
    if repositories.totalCount > repo_limit:
        print(f"Limiting to {repo_limit} repositories")

    configs = []
    # Iterate over the first 200 repositories and decode the content of the files
    for repo in repositories[:repo_limit]:
        try:
            content = repo.decoded_content.decode('utf-8')
            configs.extend(content.splitlines())
        except Exception as e:
            print(f"Error decoding content from {repo.repository.full_name}/{repo.path}: {e}")

    return configs

def config_to_base64(config):
    """
    Encode the given config to base64.
    """
    return base64.b64encode(config.encode('utf-8')).decode('utf-8')

def main():
    """
    Main function.
    """
    # Load sources from the JSON file
    with open(SOURCES_FILE, 'r') as f:
        sources = json.load(f)

    # Fetch configs from static sources
    # Using f-string for better readability
    print(f"Found {len(sources['static'])} configs for static sources.")
    for source in sources["static"]:
        final_configs["xray"].extend(fetch_configs_from_url(source))

    # Fetch configs from dynamic sources (GitHub)
    print("Searching GitHub for fresh dynamic sources...")
    github_configs = search_github_for_configs()
    print(f"Found {len(github_configs)} configs from dynamic sources.")
    final_configs["xray"].extend(github_configs)

    # Remove duplicates and invalid protocols and empty lines
    final_configs["xray"] = list(set(filter(lambda x: is_valid_protocol(x) and x, final_configs["xray"])))
    print(f"Total unique configs after enrichment: {len(final_configs['xray'])}")

    # Separate configs into xray and singbox
    for config in final_configs["xray"]:
        if "vless" in config or "vmess" in config or "trojan" in config:
            final_configs["singbox"].append(config)

    # Generate Clash file from all found xray configs
    print("Generating Clash file from all found xray configs...")
    all_xray_for_clash = final_configs['xray']
    base64_configs = [config_to_base64(config) for config in all_xray_for_clash]

    with open(CLASH_CONFIG_FILE, 'r') as f:
        clash_config = f.read()

    with open(CLASH_CONFIGS_FILE, 'w') as f:
        f.write(clash_config.replace("GITHUB_PLACEHOLDER", '\n'.join([f"  - {config}" for config in base64_configs])))

    # Generate sing-box file from all found sing-box configs
    print("Generating sing-box file from all found sing-box configs...")
    with open(SINGBOX_CONFIG_FILE, 'r') as f:
        singbox_config = json.load(f)

    # Find the index of the outbound with the tag "Internet"
    outbound_index = next((i for i, outbound in enumerate(singbox_config["outbounds"]) if outbound["tag"] == "Internet"), None)
    if outbound_index is not None:
        # Extend the servers list with the new configs
        singbox_config["outbounds"][outbound_index]["servers"].extend(final_configs["singbox"])

    with open(SINGBOX_CONFIGS_FILE, 'w') as f:
        json.dump(singbox_config, f, indent=4)

    # Write all live configs to the file
    with open(LIVE_CONFIGS_FILE, 'w') as f:
        json.dump(final_configs, f, indent=4)

if __name__ == "__main__":
    main()
