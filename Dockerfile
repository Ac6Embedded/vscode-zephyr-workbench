FROM ubuntu:24.04

ARG USERNAME=trainee
ARG PASSWORD

ENV DEBIAN_FRONTEND=noninteractive \
    USERNAME=${USERNAME}

ENV USER_HOME=/home/${USERNAME}
ENV VSCODE_EXTENSIONS_DIR=${USER_HOME}/.vscode/extensions

# Base packages for VS Code repo setup and hosttools root stage
RUN apt-get update && apt-get install -y --no-install-recommends \
    sudo \
    ca-certificates \
    curl \
    wget \
    gpg \
    lsb-release \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Install VS Code from the Microsoft apt repository
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /etc/apt/keyrings/packages.microsoft.gpg \
    && chmod go+r /etc/apt/keyrings/packages.microsoft.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends code \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for extension install and non-root hosttools stage
RUN useradd -m -s /bin/bash ${USERNAME} \
    && if [ -n "${PASSWORD}" ]; then echo "${USERNAME}:${PASSWORD}" | chpasswd; fi \
    && usermod -aG sudo ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME}

USER ${USERNAME}
ENV HOME=${USER_HOME}

# Install Workbench for Zephyr extension
RUN /usr/bin/code --install-extension Ac6.zephyr-workbench --force

# Run hosttools root stage (same Linux flow used by the extension)
USER root
RUN /bin/bash ${VSCODE_EXTENSIONS_DIR}/ac6.zephyr-workbench-*/scripts/hosttools/install.sh \
    --only-root \
    ${USER_HOME}

# Run hosttools non-root stage
USER ${USERNAME}
RUN /bin/bash ${VSCODE_EXTENSIONS_DIR}/ac6.zephyr-workbench-*/scripts/hosttools/install.sh \
    --only-without-root \
    ${USER_HOME}

WORKDIR ${USER_HOME}
CMD ["/bin/bash"]