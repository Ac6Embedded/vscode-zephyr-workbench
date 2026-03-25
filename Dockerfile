ARG ZEPHYR_BUILD_IMAGE=zephyrprojectrtos/zephyr-build:latest
FROM ${ZEPHYR_BUILD_IMAGE}

ARG USERNAME=trainee
ARG USER_UID=1000
ARG USER_GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    USERNAME=${USERNAME} \
    USER_HOME=/home/${USERNAME} \
    ZEPHYR_WORKBENCH_HOME=/opt/zephyr-workbench \
    ZEPHYR_WORKBENCH_TOOLS_DIR=/home/${USERNAME}/.zinstaller

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Minimal runtime packages required by the Workbench host tools installer.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        lsb-release \
        sudo \
    && rm -rf /var/lib/apt/lists/*

# Create a regular user to mirror the extension's non-root install flow.
RUN groupadd --gid ${USER_GID} ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME} \
    && usermod -aG sudo ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
    && chmod 0440 /etc/sudoers.d/${USERNAME}

COPY scripts/hosttools/ ${ZEPHYR_WORKBENCH_HOME}/scripts/hosttools/

RUN chmod +x ${ZEPHYR_WORKBENCH_HOME}/scripts/hosttools/*.sh

# Install OS packages first as root, then hand ownership back to the user for
# the non-root tool and virtualenv installation stage.
RUN ${ZEPHYR_WORKBENCH_HOME}/scripts/hosttools/install.sh --only-root ${USER_HOME} \
    && chown -R ${USERNAME}:${USERNAME} ${USER_HOME}

USER ${USERNAME}
ENV HOME=${USER_HOME}
ENV PATH=${USER_HOME}/bin:${USER_HOME}/.zinstaller/.venv/bin:${PATH}

RUN ${ZEPHYR_WORKBENCH_HOME}/scripts/hosttools/install.sh --only-without-root ${USER_HOME}

# Expose stable command locations for CI jobs without requiring an interactive shell.
RUN mkdir -p ${USER_HOME}/bin \
    && ln -sf ${USER_HOME}/.zinstaller/tools/ninja/ninja ${USER_HOME}/bin/ninja \
    && ln -sf ${USER_HOME}/.zinstaller/tools/yq/yq ${USER_HOME}/bin/yq \
    && if [[ -x "${USER_HOME}/.zinstaller/.venv/bin/west" ]]; then ln -sf "${USER_HOME}/.zinstaller/.venv/bin/west" "${USER_HOME}/bin/west"; fi \
    && cmake_dir="$(find "${USER_HOME}/.zinstaller/tools" -maxdepth 1 -type d -name 'cmake-*-linux-*' | head -n 1)" \
    && if [[ -n "${cmake_dir}" ]]; then \
        ln -sf "${cmake_dir}/bin/cmake" "${USER_HOME}/bin/cmake"; \
        ln -sf "${cmake_dir}/bin/ctest" "${USER_HOME}/bin/ctest"; \
        ln -sf "${cmake_dir}/bin/cpack" "${USER_HOME}/bin/cpack"; \
    fi \
    && echo 'if [ -f "$HOME/.zinstaller/env.sh" ]; then . "$HOME/.zinstaller/env.sh"; fi' >> ${USER_HOME}/.bashrc

WORKDIR /workspaces
CMD ["/bin/bash"]
