import type { Blockchain, Preferences } from "@coral-xyz/common";

import type { UserPublicKeys } from "../../store/keyring";
import type { KeyringStoreState } from "../../types/keyring";
import type { SecureEventBase } from "../../types/transports";

// Also add new events to: ../../events.ts

export type SECURE_USER_EVENTS =
  | "SECURE_USER_UNLOCK_KEYRING"
  | "SECURE_USER_GET";

export interface SECURE_USER_UNLOCK_KEYRING
  extends SecureEventBase<"SECURE_USER_UNLOCK_KEYRING"> {
  request: {
    uuid?: string;
    password?: string;
  };
  response: {
    unlocked: boolean;
  };
  confirmationResponse: {
    unlocked: boolean;
  };
}

export interface SECURE_USER_GET extends SecureEventBase<"SECURE_USER_GET"> {
  request: {};
  response: {
    keyringState: KeyringStoreState;
    user?: {
      uuid: string;
      jwt: string;
      username: string;
      preferences: Preferences;
    };
    activePublicKeys?: Partial<Record<Blockchain, string>>;
    publicKeys?: UserPublicKeys | null;
  };
}