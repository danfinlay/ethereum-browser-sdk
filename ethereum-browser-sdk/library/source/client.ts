import { Handshake, HotOstrich, MessageEnvelope, EthereumEnvelope, ClientMessage, ProviderMessage, Message, BaseRequest, BaseResponse, ProviderResponse } from "./shared";
import { FutureUnion, Future } from "./future";
import { assertNever, newCorrelationId } from "./utils";

abstract class Channel<T extends MessageEnvelope> {
	protected constructor(private readonly window: Window) {
		this.window.addEventListener('message', this.onMessage)
	}

	public readonly shutdown = () => {
		this.window.removeEventListener('message', this.onMessage)
	}

	private readonly onMessage = (messageEvent: MessageEvent) => {
		try {
			if (!isEthereumMessageEvent(messageEvent)) return
			if (messageEvent.data.ethereum.channel !== this.providerChannelName) return
			// CONSIDER: error here instead of silently returning if we see messages over this channel that we don't expect
			if (!this.isT(messageEvent.data.ethereum)) return
			if (!isProviderMessage(messageEvent.data.ethereum.message)) return
			// https://github.com/microsoft/TypeScript/issues/32591
			this.onProviderMessage(messageEvent.data.ethereum.message as Extract<T['message'], ProviderMessage>)
		} catch (error) {
			if (error instanceof Error) {
				this.onError(error)
			} else if (typeof error === 'string') {
				this.onError(new Error(error))
			} else {
				this.onError(new Error(JSON.stringify(error)))
			}
		}
	}

	protected readonly send = (message: ClientMessage): void => {
		const ethereumEnvelope: EthereumEnvelope = {
			ethereum: {
				channel: this.clientChannelName,
				kind: this.kind,
				message: message,
			} as MessageEnvelope // _we_ know that T will always be _either_ Handshake.Envelope _OR_ HotOstrich.Envelope, but the compiler thinks _BOTH_ is possible, so we have to cast
		}
		if (this.window.parent && this.window.parent !== this.window) {
			this.window.parent.postMessage(ethereumEnvelope, '*')
		}
		this.window.postMessage(ethereumEnvelope, '*')
	}

	private readonly isT = (messageEnvelope: MessageEnvelope): messageEnvelope is T => messageEnvelope.kind === this.kind

	protected abstract readonly onProviderMessage: (message: Extract<T['message'], ProviderMessage>) => void
	protected abstract readonly onError: (error: Error) => void
	protected abstract readonly providerChannelName: T['channel']
	protected abstract readonly clientChannelName: T['channel']
	protected abstract readonly kind: T['kind']
}

export interface HandshakeHandlers {
	readonly onError: (error: Error) => void
	readonly onProviderAnnounced: (announcement: Handshake.ProviderAnnouncementNotification['payload']) => void
}

export class HandshakeChannel extends Channel<Handshake.Envelope> {
	public constructor(window: Window, private readonly handshakeHandlers: HandshakeHandlers) {
		super(window)
		this.announceClient()
	}

	public readonly reRequestProviders = (): void => {
		this.announceClient()
	}

	public readonly knownProviders: Record<string, Handshake.ProviderAnnouncementNotification['payload']> = {}

	protected readonly onError = this.handshakeHandlers.onError
	protected readonly providerChannelName = Handshake.PROVIDER_CHANNEL_NAME
	protected readonly clientChannelName = Handshake.CLIENT_CHANNEL_NAME
	protected readonly kind = Handshake.KIND

	protected readonly onProviderMessage = (message: Handshake.ProviderMessage): void => {
		switch (message.type) {
			case 'notification': return this.onNotification(message)
			// TS doesn't support discriminated unions of one type, so we can't assertNever(message) until at least 2 types are in the Handshake.Event union; if a second is added change this to assertNever(message)
			default: return assertNever(message.type)
		}
	}

	private readonly onNotification = (notification: Handshake.ProviderNotification): void => {
		switch (notification.kind) {
			case 'provider_announcement': return this.onProviderAnnouncement(notification.payload)
			// TS doesn't support discriminated unions of one type, so we can't assertNever(event) until at least 2 types are in the Handshake.Event union; if a second is added change this to assertNever(event)
			default: return assertNever(notification.kind)
		}
	}

	private readonly onProviderAnnouncement = (announcement: Handshake.ProviderAnnouncementNotification['payload']) => {
		this.knownProviders[announcement.provider_id] = announcement
		this.handshakeHandlers.onProviderAnnounced(announcement)
	}

	private readonly announceClient = (): void => {
		this.send({
			kind: 'client_announcement',
			type: 'broadcast',
			payload: {},
		})
	}
}

export interface HotOstrichHandlers {
	readonly onError: (error: Error) => void
	readonly onSignerAddressChanged: (newSignerAddress: Uint8Array) => void
}

export class HotOstrichChannel extends Channel<HotOstrich.Envelope> {
	public static readonly supportedProtocols = [{ name: HotOstrich.KIND, version: HotOstrich.VERSION }] as const

	public constructor(window: Window, private readonly providerId: string, private readonly hotOstrichHandlers: HotOstrichHandlers) {
		super(window)
	}

	public readonly getCapabilities = async (): Promise<ReadonlyArray<'sign'|'call'|'submit'|'log_subscription'|'log_history'>> => (await this.promisify<HotOstrich.GetCapabilities.Request, HotOstrich.GetCapabilities.SuccessResponse>('get_capabilities', {})).capabilities

	public readonly submitNativeTokenTransfer = async (payload: HotOstrich.SubmitNativeTokenTransfer.Request['payload']): Promise<HotOstrich.SubmitNativeTokenTransfer.SuccessResponse['payload']> => await this.promisify<HotOstrich.SubmitNativeTokenTransfer.Request, HotOstrich.SubmitNativeTokenTransfer.SuccessResponse>('submit_native_token_transfer', payload)

	public readonly submitContractCall = async (payload: HotOstrich.SubmitContractCall.Request['payload']): Promise<HotOstrich.SubmitContractCall.SuccessResponse['payload']> => await this.promisify<HotOstrich.SubmitContractCall.Request, HotOstrich.SubmitContractCall.SuccessResponse>('submit_contract_call', payload)

	public readonly submitContractDeployment = async (payload: HotOstrich.SubmitContractDeployment.Request['payload']): Promise<HotOstrich.SubmitContractDeployment.SuccessResponse['payload']> => await this.promisify<HotOstrich.SubmitContractDeployment.Request, HotOstrich.SubmitContractDeployment.SuccessResponse>('submit_contract_deployment', payload)

	public readonly signMessage = async (payload: string): Promise<HotOstrich.SignMessage.SuccessResponse['payload']> => await this.promisify<HotOstrich.SignMessage.Request, HotOstrich.SignMessage.SuccessResponse>('sign_message', { message: payload })

	public readonly localContractCall = async (payload: HotOstrich.LocalContractCall.Request['payload']): Promise<Uint8Array> => (await this.promisify<HotOstrich.LocalContractCall.Request, HotOstrich.LocalContractCall.SuccessResponse>('local_contract_call', payload)).result

	public readonly getSignerAddress = async (): Promise<Uint8Array> => (await this.promisify<HotOstrich.GetSignerAddress.Request, HotOstrich.GetSignerAddress.SuccessResponse>('get_signer_address', {})).address

	private readonly promisify = <TRequest extends HotOstrich.ClientRequest, TResponse extends Extract<HotOstrich.ProviderResponse, {success:true}>>(kind: TRequest['kind'] & TResponse['kind'], requestPayload: TRequest['payload']): Promise<TResponse['payload']> => {
		const entryTime = Date.now()
		const correlationId = newCorrelationId()
		const message = {
			type: 'request' as const,
			kind: kind,
			correlation_id: correlationId,
			payload: requestPayload,
		}
		// we cast on the following 3 lines because we know that T will always be _one of_ the possible `ClientRequest`s, but the compiler thinks that T can be a union of `ClientRequest`s
		// https://github.com/microsoft/TypeScript/issues/20375
		this.send(message as TRequest)
		const future = new Future<ProviderResponsePayload<TResponse['kind']>>() as FutureUnion<ProviderResponsePayload<TResponse['kind']>>
		const pendingRequest = { kind, entryTime, correlationId, future } as PendingRequestUnion<HotOstrich.ClientRequest>
		this.pendingRequests.push(pendingRequest)
		return future.asPromise
	}

	protected readonly onError = this.hotOstrichHandlers.onError
	protected readonly providerChannelName = `${HotOstrich.PROVIDER_CHANNEL_PREFIX}${this.providerId}`
	protected readonly clientChannelName = `${HotOstrich.CLIENT_CHANNEL_PREFIX}${this.providerId}`
	protected readonly kind = HotOstrich.KIND

	protected readonly onProviderMessage = (message: HotOstrich.ProviderMessage): void => {
		switch (message.type) {
			case 'response': return this.onHotOstrichResponse(message)
			case 'notification': return this.onHotOstrichNotification(message)
			default: return assertNever(message)
		}
	}

	private pendingRequests: Array<PendingRequestUnion<HotOstrich.ClientRequest>> = []

	private readonly onHotOstrichResponse = (response: HotOstrich.ProviderResponse): void => {
		const pendingRequest = this.pendingRequests.find(pendingRequest => pendingRequest.correlationId === response.correlation_id)
		if (pendingRequest === undefined) throw new Error(`Received a response without finding a matching request.  Maybe it already timed out?  ${JSON.stringify(response)}`)
		// TODO: `response` should be treated as untrusted user input and validate before resolving the promise with it.  If it doesn't match expectations then we should reject with an appropriate error rather than pushing the problem downstream
		const future = (pendingRequest.future as Future<typeof response.payload>)
		if (response.success) {
			future.resolve(response.payload)
		} else {
			future.reject(new Error(`Failure response from provider.  ${JSON.stringify(response.payload)}`))
		}
	}

	private readonly onHotOstrichNotification = (notification: HotOstrich.ProviderNotification) => {
		switch (notification.kind) {
			case 'signer_address_changed': return this.onSignerAddressChanged(notification)
			// TS doesn't support discriminated unions of one type, so we can't assertNever(event) until at least 2 types are in the HotOstrichEvent union; if a second is added change this to assertNever(event)
			default: return assertNever(notification.kind)
		}
	}

	private readonly onSignerAddressChanged = (notification: HotOstrich.SignerAddressChanged): void => {
		this.hotOstrichHandlers.onSignerAddressChanged(notification.payload.address)
	}
}

export interface EthereumMessageEvent extends MessageEvent {
	data: EthereumEnvelope
}

const isEthereumMessageEvent = (event: MessageEvent): event is EthereumMessageEvent => typeof event.data === 'object' && 'ethereum' in event.data && typeof event.data.ethereum === 'object'
const isProviderMessage = (message: Message): message is ProviderMessage => message.type === 'notification' || message.type === 'response'

type ProviderResponsePayload<T extends BaseResponse['kind']> = Extract<ProviderResponse, {kind:T, success: true}>['payload']
interface PendingRequest<T extends BaseRequest> {
	entryTime: number
	correlationId: string
	kind: T['kind']
	future: FutureUnion<ProviderResponsePayload<T['kind']>>
}
type PendingRequestUnion<T extends BaseRequest> = T extends any ? PendingRequest<T> : never