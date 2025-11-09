# --- env-utils.sh ---

# Update the env.yml file with tool metadata
# Arguments:
#   1 - Tool name (e.g., "jlink")
#   2 - Path to yq executable (e.g., "yq")
#   3 - Path to env.yml
#   4 - Tool installation path (forward slashes)
#   5 - Tool version (e.g., "Linux_V878_x86_64")
update_env_yaml_block() {
    local tool_name="$1"
    local yq_path="$2"
    local env_yaml_path="$3"
    local tool_path="$4"
    local version="$5"

    if [[ ! -f "$env_yaml_path" ]]; then
        echo "ERROR: env.yml not found at $env_yaml_path"
        return 1
    fi

    echo "Updating env.yml for $tool_name using yq..."

    # Reset the section first to ensure a clean structure
    "$yq_path" eval ".runners.${tool_name} = {}" -i "$env_yaml_path"

    # Write values
    "$yq_path" eval ".runners.${tool_name}.path = \"${tool_path}\"" -i "$env_yaml_path"
    "$yq_path" eval ".runners.${tool_name}.version = \"${version}\"" -i "$env_yaml_path"
    "$yq_path" eval ".runners.${tool_name}.do_not_use = false" -i "$env_yaml_path"

    if [[ $? -eq 0 ]]; then
        echo "Updated env.yml successfully for ${tool_name}:"
        echo "  path: ${tool_path}"
        echo "  version: ${version}"
    else
        echo "Failed to update env.yml for ${tool_name} using yq."
        return 1
    fi
}
