export type RpcMethodMap = Record<string, { params?: any; result: any }>;

export type RpcHandlerMap<M extends RpcMethodMap> = {
  [K in keyof M]: (params: M[K]["params"]) => Promise<M[K]["result"]> | M[K]["result"];
};

export type OpenDialog = {
  params: {
    canSelectFiles: boolean;
    canSelectFolders: boolean;
    canSelectMany?: boolean;
    title?: string;
    defaultUri?: string;
  },
  result: {
    canceled: boolean;
    paths: string[];
  },
};

export type EclairRpcMethods = {
  "open-dialog": OpenDialog;
};
