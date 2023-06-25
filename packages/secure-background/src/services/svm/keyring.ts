import type { WalletDescriptor } from "@coral-xyz/common";
import {
  Blockchain,
  deserializeTransaction,
  getIndexedPath,
  LEDGER_METHOD_SOLANA_SIGN_MESSAGE,
  LEDGER_METHOD_SOLANA_SIGN_TRANSACTION,
  nextIndicesFromPaths,
} from "@coral-xyz/common";
import { Keypair, PublicKey } from "@solana/web3.js";
import { mnemonicToSeedSync, validateMnemonic } from "bip39";
import { ethers, Wallet } from "ethers";
import nacl from "tweetnacl";

import { LedgerKeyringBase } from "../../keyring/ledger";
import type {
  HdKeyring,
  HdKeyringFactory,
  HdKeyringJson,
  Keyring,
  KeyringBase,
  KeyringFactory,
  KeyringJson,
  LedgerKeyring,
  LedgerKeyringJson,
} from "../../keyring/types";
import type { TransportResponder } from "../../transports/TransportResponder";
import type { SecureRequest } from "../../types/transports";
import type {
  LEDGER_SVM_SIGN_TX,
  SECURE_LEDGER_EVENTS,
} from "../ledger/events";

import { SECURE_SVM_SIGN_TX } from "./events";
import { deriveSolanaKeypair } from "./util";

const { base58 } = ethers.utils;

export class SolanaKeyringFactory implements KeyringFactory {
  public init(secretKeys: Array<string>): SolanaKeyring {
    const keypairs = secretKeys.map((secret: string) =>
      Keypair.fromSecretKey(Buffer.from(secret, "hex"))
    );
    return new SolanaKeyring(keypairs);
  }

  public fromJson(payload: KeyringJson): SolanaKeyring {
    const keypairs = payload.secretKeys.map((secret: string) =>
      Keypair.fromSecretKey(Buffer.from(secret, "hex"))
    );
    return new SolanaKeyring(keypairs);
  }
}

class SolanaKeyringBase implements KeyringBase {
  constructor(public keypairs: Array<Keypair>) {}

  public publicKeys(): Array<string> {
    return this.keypairs.map((kp) => kp.publicKey.toString());
  }

  public deletePublicKey(publicKey: string) {
    this.keypairs = this.keypairs.filter(
      (kp) => kp.publicKey.toString() !== publicKey
    );
  }

  // `address` is the key on the keyring to use for signing.
  public async signTransaction(tx: Buffer, address: string): Promise<string> {
    const pubkey = new PublicKey(address);
    const kp = this.keypairs.find((kp) => kp.publicKey.equals(pubkey));
    if (!kp) {
      throw new Error(`unable to find ${address.toString()}`);
    }
    return base58.encode(nacl.sign.detached(new Uint8Array(tx), kp.secretKey));
  }

  public async signMessage(tx: Buffer, address: string): Promise<string> {
    // TODO: this shouldn't blindly sign. We should check some
    //       type of unique prefix that asserts this isn't a
    //       real transaction.
    return this.signTransaction(tx, address);
  }

  public exportSecretKey(address: string): string | null {
    const pubkey = new PublicKey(address);
    const kp = this.keypairs.find((kp) => kp.publicKey.equals(pubkey));
    if (!kp) {
      return null;
    }
    return base58.encode(kp.secretKey);
  }

  public importSecretKey(secretKey: string): string {
    const kp = Keypair.fromSecretKey(Buffer.from(secretKey, "hex"));
    this.keypairs.push(kp);
    return kp.publicKey.toString();
  }
}

class SolanaKeyring extends SolanaKeyringBase implements Keyring {
  public toJson(): KeyringJson {
    return {
      secretKeys: this.keypairs.map((kp) =>
        Buffer.from(kp.secretKey).toString("hex")
      ),
    };
  }
}

export class SolanaHdKeyringFactory implements HdKeyringFactory {
  public init(
    mnemonic: string,
    derivationPaths: Array<string>,
    accountIndex?: number,
    walletIndex?: number
  ): HdKeyring {
    if (!validateMnemonic(mnemonic)) {
      throw new Error("Invalid seed words");
    }
    return new SolanaHdKeyring({
      mnemonic,
      seed: mnemonicToSeedSync(mnemonic),
      derivationPaths,
      accountIndex,
      walletIndex,
    });
  }

  public fromJson({
    mnemonic,
    seed,
    derivationPaths,
    accountIndex,
    walletIndex,
  }: HdKeyringJson): HdKeyring {
    return new SolanaHdKeyring({
      mnemonic,
      seed: Buffer.from(seed, "hex"),
      derivationPaths,
      accountIndex,
      walletIndex,
    });
  }
}

class SolanaHdKeyring extends SolanaKeyringBase implements HdKeyring {
  readonly mnemonic: string;
  private seed: Buffer;
  private derivationPaths: Array<string>;
  private accountIndex?: number;
  private walletIndex?: number;

  constructor({
    mnemonic,
    seed,
    derivationPaths,
    accountIndex,
    walletIndex,
  }: {
    mnemonic: string;
    seed: Buffer;
    derivationPaths: Array<string>;
    accountIndex?: number;
    walletIndex?: number;
  }) {
    const keypairs = derivationPaths.map((d) => deriveSolanaKeypair(seed, d));
    super(keypairs);
    this.mnemonic = mnemonic;
    this.seed = seed;
    this.derivationPaths = derivationPaths;
    this.accountIndex = accountIndex;
    this.walletIndex = walletIndex;
  }

  public deletePublicKey(publicKey: string) {
    const index = this.keypairs.findIndex(
      (kp) => kp.publicKey.toString() === publicKey
    );
    if (index < 0) {
      return;
    }
    this.derivationPaths = this.derivationPaths
      .slice(0, index)
      .concat(this.derivationPaths.slice(index + 1));
    super.deletePublicKey(publicKey);
  }

  public nextDerivationPath(offset = 1) {
    this.ensureIndices();
    const derivationPath = getIndexedPath(
      Blockchain.SOLANA,
      this.accountIndex,
      this.walletIndex! + offset
    );
    if (this.derivationPaths.includes(derivationPath)) {
      // This key is already included for some reason, try again with
      // incremented walletIndex
      return this.nextDerivationPath(offset + 1);
    }
    return { derivationPath, offset };
  }

  public deriveNextKey(): {
    publicKey: string;
    derivationPath: string;
  } {
    const { derivationPath, offset } = this.nextDerivationPath();
    // Save the offset to the wallet index
    this.walletIndex! += offset;
    const publicKey = this.addDerivationPath(derivationPath);
    return {
      publicKey,
      derivationPath,
    };
  }

  public addDerivationPath(derivationPath: string): string {
    const keypair = deriveSolanaKeypair(this.seed, derivationPath);
    if (!this.derivationPaths.includes(derivationPath)) {
      // Don't persist duplicate public keys
      this.keypairs.push(keypair);
      this.derivationPaths.push(derivationPath);
    }
    return keypair.publicKey.toString();
  }

  // TODO duplicated in the evm keyring
  ensureIndices() {
    // If account index and wallet index don't exist, make a best guess based
    // on the existing derivation paths for the keyring
    if (this.accountIndex === undefined || this.walletIndex === undefined) {
      const { accountIndex, walletIndex } = nextIndicesFromPaths(
        this.derivationPaths
      );
      if (!this.accountIndex) this.accountIndex = accountIndex;
      if (!this.walletIndex) this.walletIndex = walletIndex;
    }
  }

  public toJson(): HdKeyringJson {
    return {
      mnemonic: this.mnemonic,
      seed: this.seed.toString("hex"),
      derivationPaths: this.derivationPaths,
      accountIndex: this.accountIndex,
      walletIndex: this.walletIndex,
    };
  }
}

export class SolanaLedgerKeyringFactory {
  public init(walletDescriptors: Array<WalletDescriptor>): LedgerKeyring {
    return new SolanaLedgerKeyring(walletDescriptors, Blockchain.SOLANA);
  }

  public fromJson(obj: LedgerKeyringJson): LedgerKeyring {
    return new SolanaLedgerKeyring(obj.walletDescriptors, Blockchain.SOLANA);
  }
}

class SolanaLedgerKeyring extends LedgerKeyringBase implements LedgerKeyring {
  public async signTransaction(tx: Buffer, publicKey: string): Promise<string> {
    const walletDescriptor = this.walletDescriptors.find(
      (p) => p.publicKey === publicKey
    );
    if (!walletDescriptor) {
      throw new Error("ledger address not found");
    }
    return await this.request({
      method: LEDGER_METHOD_SOLANA_SIGN_TRANSACTION,
      params: [
        base58.encode(tx),
        walletDescriptor.derivationPath.replace("m/", ""),
      ],
    });
  }

  public async signMessage(msg: Buffer, publicKey: string): Promise<string> {
    const walletDescriptor = this.walletDescriptors.find(
      (p) => p.publicKey === publicKey
    );
    if (!walletDescriptor) {
      throw new Error("ledger public key not found");
    }
    return await this.request({
      method: LEDGER_METHOD_SOLANA_SIGN_MESSAGE,
      params: [
        base58.encode(msg),
        walletDescriptor.derivationPath.replace("m/", ""),
      ],
    });
  }

  public async prepareSignTransaction(
    request: SecureRequest<"SECURE_SVM_SIGN_TX">["request"]
  ): Promise<SecureRequest<"LEDGER_SVM_SIGN_TX">["request"]> {
    const walletDescriptor = this.walletDescriptors.find(
      (p) => p.publicKey === request.publicKey
    );
    if (!walletDescriptor) {
      throw new Error("ledger address not found");
    }

    const transaction = deserializeTransaction(request.tx);
    const message = transaction.message.serialize();
    const txMessage = base58.encode(message);

    return {
      txMessage,
      derivationPath: walletDescriptor.derivationPath.replace("m/", ""),
    };
  }

  public async prepareSignMessage(
    request: SecureRequest<"SECURE_SVM_SIGN_MESSAGE">["request"]
  ): Promise<SecureRequest<"LEDGER_SVM_SIGN_MESSAGE">["request"]> {
    const walletDescriptor = this.walletDescriptors.find(
      (p) => p.publicKey === request.publicKey
    );
    if (!walletDescriptor) {
      throw new Error("ledger address not found");
    }

    // https://github.com/solana-labs/solana/blob/e80f67dd58b7fa3901168055211f346164efa43a/docs/src/proposals/off-chain-message-signing.md
    const message = Buffer.from(base58.decode(request.message));
    const firstByte = Buffer.from(new Uint8Array([255]));
    const domain = Buffer.from("solana offchain");
    const headerVersion8Bit = Buffer.from(new Uint8Array([0]));
    const headerFormat8Bit = Buffer.from(new Uint8Array([0]));

    const headerLength16Bit = Buffer.alloc(2, 0);
    Buffer.from(new Uint16Array([message.length])).copy(headerLength16Bit);

    const payload = Buffer.concat([
      firstByte,
      domain,
      headerVersion8Bit,
      headerFormat8Bit,
      headerLength16Bit,
      message,
    ]);

    return {
      message: base58.encode(payload),
      derivationPath: walletDescriptor.derivationPath.replace("m/", ""),
    };
  }
}
