export class EmergencyCheckUncertainError extends Error {
    constructor() {
        super('Emergency context check could not be determined');
        this.name = 'EmergencyCheckUncertainError';
    }
}